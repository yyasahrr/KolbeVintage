import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool, type DbClient } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { ensureContact, recordTimeline } from './crm-intelligence.js';

const stage = z.enum(['lead','prospect','active','loyal','at_risk','dormant','churned','partner']);
const priority = z.enum(['low','normal','high','urgent']);
const channel = z.enum(['call','sms','whatsapp','email','meeting','other']);
const outcome = z.enum(['successful','no_answer','follow_up','closed','neutral']);

// Identity comparison only; canonical user identity remains owned by users.
const phoneKey = (expression: string) => `regexp_replace(regexp_replace(translate(COALESCE(${expression},''),'۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩','01234567890123456789'),'[^0-9]','','g'),'^(0098|98|0)(?=9[0-9]{9}$)','','g')`;
async function validateOwner(db: DbClient | DbPool, id: string | null | undefined) {
  if (!id) return;
  const owner = await one(db, `SELECT u.id FROM users u WHERE u.id=$1 AND u.status='active'
    AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_code=ur.role_code
      WHERE ur.user_id=u.id AND rp.permission_code='crm:manage')`, [id]);
  if (!owner) throw badRequest('مسئول انتخاب‌شده باید حساب فعال با دسترسی مدیریت ارتباط داشته باشد.');
}
async function refreshFollowup(client: DbClient, contactId: string) {
  await client.query(`UPDATE crm_contacts SET next_followup_at=(
    SELECT min(due_at) FROM crm_tasks WHERE contact_id=$1 AND status='open'),updated_at=now() WHERE id=$1`, [contactId]);
}
async function projectLinkedInteractions(client:DbClient,contactId:string,userId:string) {
  const rows=await client.query<{id:string;subject:string;body:string;occurred_at:Date}>(`SELECT i.id,i.subject,i.body,i.occurred_at FROM crm_interactions i
    WHERE i.contact_id=$1 AND NOT EXISTS(SELECT 1 FROM customer_timeline t WHERE t.user_id=$2 AND t.ref_type='crm_interaction' AND t.ref_id=i.id::text)`,[contactId,userId]);
  for(const row of rows.rows)await recordTimeline(client,{userId,eventType:'crm.interaction',title:row.subject,description:row.body,source:'crm',refType:'crm_interaction',refId:row.id,occurredAt:new Date(row.occurred_at)});
}

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
      await validateOwner(client, body.ownerUserId);
      // Serialize identity checks and writes so concurrent lead submissions cannot both pass.
      await client.query("SELECT pg_advisory_xact_lock(71001)");
      const duplicate = await one(client, `SELECT id FROM (
        SELECT id,email,phone FROM users UNION ALL
        SELECT id,lead_email,lead_phone FROM crm_contacts WHERE user_id IS NULL
      ) identities WHERE ($1::text IS NOT NULL AND lower(trim(email))=lower(trim($1)))
        OR ($2::text IS NOT NULL AND ${phoneKey('phone')}<>'' AND ${phoneKey('phone')}=${phoneKey('$2::text')}) LIMIT 1`,
        [body.email ?? null, body.phone?.trim() || null]);
      if (duplicate) throw conflict('برای این ایمیل یا شماره تماس از قبل حساب یا پرونده ارتباط وجود دارد.');
      await client.query(
        `INSERT INTO crm_contacts(id,actor_type,lifecycle_stage,priority,owner_user_id,next_followup_at,lead_name,lead_phone,lead_email,organization,metadata)
         VALUES ($1,'other','lead',$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`,
        [id, body.priority, body.ownerUserId ?? null, body.nextFollowupAt ?? null, body.name, body.phone ?? null, body.email ?? null, body.organization ?? null]);
      if (body.nextFollowupAt) await client.query(`INSERT INTO crm_tasks(id,contact_id,title,assigned_to,due_at,priority,created_by)
        VALUES($1,$2,'پیگیری اولیه سرنخ',$3,$4,$5,$6)`, [randomUUID(),id,body.ownerUserId ?? null,body.nextFollowupAt,body.priority,actor.id]);
      await audit(client, actor.id, 'crm.lead_created', 'crm_contact', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id });
  });

  app.post('/api/v1/admin/crm/contacts/:id/link-user', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { userId } = z.object({ userId: z.uuid() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const targetUser = await one<{ id: string; actor_type: string }>(client,`
        SELECT u.id,CASE WHEN EXISTS(SELECT 1 FROM supplier_profiles WHERE user_id=u.id) THEN 'supplier'
                         WHEN EXISTS(SELECT 1 FROM buyer_profiles WHERE user_id=u.id) THEN 'wholesale_buyer'
                         ELSE 'customer' END AS actor_type
        FROM users u WHERE u.id=$1 FOR UPDATE`,[userId]);
      if (!targetUser) throw notFound('حساب مقصد پیدا نشد.');
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_contacts WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (before.user_id) throw conflict('این پرونده از قبل به یک حساب متصل است.');

      const existing = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_contacts WHERE user_id = $1 FOR UPDATE', [userId]);
      if (existing && String(existing.id) !== id) {
        await client.query('UPDATE crm_notes SET contact_id=$2 WHERE contact_id=$1',[id,existing.id]);
        await client.query('UPDATE crm_tasks SET contact_id=$2 WHERE contact_id=$1',[id,existing.id]);
        await client.query('UPDATE crm_interactions SET contact_id=$2 WHERE contact_id=$1',[id,existing.id]);
        await client.query('UPDATE crm_activities SET contact_id=$2 WHERE contact_id=$1',[id,existing.id]);
        await client.query(`
          INSERT INTO crm_contact_labels(contact_id,label_code,source,rule_id,assigned_by,assigned_at,expires_at)
          SELECT $2,label_code,source,rule_id,assigned_by,assigned_at,expires_at FROM crm_contact_labels WHERE contact_id=$1
          ON CONFLICT (contact_id,label_code) DO NOTHING`,[id,existing.id]);
        await client.query('DELETE FROM crm_contact_labels WHERE contact_id=$1',[id]);
        await client.query(`
          UPDATE crm_contacts SET
            owner_user_id=COALESCE(owner_user_id,$2::uuid),
            priority=CASE WHEN priority='normal' THEN $3 ELSE priority END,
            next_followup_at=LEAST(next_followup_at,$4::timestamptz),
            lifecycle_stage=CASE WHEN lifecycle_stage='active' THEN 'active' ELSE lifecycle_stage END,
            updated_at=now()
          WHERE id=$1`,[existing.id,before.owner_user_id ?? null,before.priority ?? 'normal',before.next_followup_at ?? null]);
        await client.query('DELETE FROM crm_contacts WHERE id=$1',[id]);
        await client.query(`UPDATE crm_contacts SET last_interaction_at=(SELECT max(occurred_at) FROM crm_interactions WHERE contact_id=$1) WHERE id=$1`, [existing.id]);
        await refreshFollowup(client, String(existing.id));
        await projectLinkedInteractions(client,String(existing.id),userId);
        await audit(client, actor.id, 'crm.lead_merged_to_user', 'crm_contact', String(existing.id), before, { userId, mergedFromContactId:id }, request.ip);
        return one(client,'SELECT * FROM crm_contacts WHERE id=$1',[existing.id]);
      }

      const result = await client.query(
        `UPDATE crm_contacts SET user_id=$2, actor_type=$3, lifecycle_stage='active',
           lead_name=NULL, lead_phone=NULL, lead_email=NULL, updated_at=now()
         WHERE id=$1 RETURNING *`, [id, userId, targetUser.actor_type]);
      await audit(client, actor.id, 'crm.lead_linked_to_user', 'crm_contact', id, before, { userId }, request.ip);
      await projectLinkedInteractions(client,id,userId);
      return result.rows[0];
    });
  });

  app.get('/api/v1/admin/crm/relationship-summary', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const row = await one<Record<string, string>>(pool, `
      SELECT
        (SELECT count(*) FROM crm_tasks WHERE status='open' AND due_at < now())::text AS overdue,
        (SELECT count(*) FROM crm_tasks WHERE status='open' AND (due_at AT TIME ZONE 'Asia/Tehran')::date=(now() AT TIME ZONE 'Asia/Tehran')::date)::text AS today,
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
      view: z.enum(['all','overdue','today','upcoming','unassigned','mine','done']).default('all'),
      ownerId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
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
       WHERE t.status=CASE WHEN $2='done' THEN 'done' ELSE 'open' END
         AND ($1::uuid IS NULL OR COALESCE(t.assigned_to,c.owner_user_id)=$1)
         AND CASE $2
           WHEN 'overdue' THEN t.due_at < now()
           WHEN 'today' THEN (t.due_at AT TIME ZONE 'Asia/Tehran')::date=(now() AT TIME ZONE 'Asia/Tehran')::date
           WHEN 'mine' THEN t.assigned_to=$5::uuid
           WHEN 'upcoming' THEN t.due_at >= now()
           WHEN 'unassigned' THEN COALESCE(t.assigned_to,c.owner_user_id) IS NULL
           ELSE true END
       ORDER BY (t.due_at < now()) DESC, t.due_at ASC NULLS LAST,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
       LIMIT $3 OFFSET $4`, [query.ownerId ?? null, query.view, query.limit, query.offset, actor.id]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/crm/search', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const query = z.object({ q: z.string().trim().min(2).max(120).default(''), limit: z.coerce.number().int().min(1).max(30).default(15),
      offset:z.coerce.number().int().min(0).max(100000).default(0) }).parse(request.query);
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
      SELECT * FROM people ORDER BY sort_at DESC,user_id NULLS LAST,contact_id NULLS LAST LIMIT $2 OFFSET $3`, [query.q, query.limit,query.offset]);
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
    const [tasks, interactions, notes, labels] = await Promise.all([
      pool.query(`SELECT t.*,a.display_name AS assignee_name,cb.display_name AS created_by_name
                    FROM crm_tasks t LEFT JOIN users a ON a.id=t.assigned_to LEFT JOIN users cb ON cb.id=t.created_by
                   WHERE t.contact_id=$1 ORDER BY (t.status='open') DESC,t.due_at ASC NULLS LAST,t.created_at DESC LIMIT 100`, [id]),
      pool.query(`SELECT i.*,u.display_name AS created_by_name FROM crm_interactions i LEFT JOIN users u ON u.id=i.created_by
                   WHERE i.contact_id=$1 ORDER BY i.occurred_at DESC LIMIT 100`, [id]),
      pool.query(`SELECT n.id,n.body,n.visibility,n.created_at,u.display_name AS author_name
                    FROM crm_notes n LEFT JOIN users u ON u.id=n.author_id
                   WHERE n.contact_id=$1 AND n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 100`,[id]),
      pool.query(`SELECT l.code,l.title FROM crm_contact_labels cl JOIN crm_labels l ON l.code=cl.label_code
        WHERE cl.contact_id=$1 AND (cl.expires_at IS NULL OR cl.expires_at>now()) ORDER BY l.title LIMIT 100`,[id]),
    ]);
    return { contact, tasks: tasks.rows, interactions: interactions.rows, notes: notes.rows, labels:labels.rows };
  });

  app.post('/api/v1/admin/crm/contacts/:id/labels',async(request,reply)=>{
    const actor=await principal(request,pool,config);requirePermission(actor,'crm:manage');
    const {id}=z.object({id:z.uuid()}).parse(request.params);
    const {labelCode}=z.object({labelCode:z.string().trim().min(1).max(40)}).strict().parse(request.body);
    await transaction(pool,async(client)=>{
      const contact=await one<{user_id:string|null}>(client,'SELECT user_id FROM crm_contacts WHERE id=$1 FOR UPDATE',[id]);
      if(!contact)throw notFound();
      const label=await one<{title:string}>(client,'SELECT title FROM crm_labels WHERE code=$1 AND active=true',[labelCode]);
      if(!label)throw badRequest('برچسب انتخاب‌شده فعال نیست یا پیدا نشد.');
      const inserted=await client.query(`INSERT INTO crm_contact_labels(contact_id,label_code,source,assigned_by)
        VALUES($1,$2,'manual',$3) ON CONFLICT(contact_id,label_code) DO UPDATE SET expires_at=NULL,assigned_at=now(),assigned_by=$3 RETURNING contact_id`,[id,labelCode,actor.id]);
      if(contact.user_id&&inserted.rowCount)await recordTimeline(client,{userId:contact.user_id,eventType:'crm.label_assigned',title:`برچسب ${label.title} اعمال شد`,source:'crm',actorId:actor.id});
      await audit(client,actor.id,'crm.label_assigned','crm_contact',id,undefined,{labelCode},request.ip);
    });
    return reply.code(201).send({ok:true});
  });

  app.patch('/api/v1/admin/crm/contacts/:id/relationship', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      ownerUserId: z.uuid().nullable().optional(), lifecycleStage: stage.optional(), priority: priority.optional(),
      nextFollowupAt: z.iso.datetime().nullable().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      await validateOwner(client, body.ownerUserId);
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_contacts WHERE id=$1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await one<Record<string, unknown>>(client, `
        UPDATE crm_contacts SET
          owner_user_id=CASE WHEN $2::boolean THEN $3::uuid ELSE owner_user_id END,
          lifecycle_stage=COALESCE($4,lifecycle_stage),priority=COALESCE($5,priority),
          updated_at=now()
        WHERE id=$1 RETURNING *`,
        [id, Object.prototype.hasOwnProperty.call(body,'ownerUserId'), body.ownerUserId ?? null, body.lifecycleStage ?? null,
         body.priority ?? null]);
      if (Object.prototype.hasOwnProperty.call(body,'nextFollowupAt')) {
        if (!body.nextFollowupAt) throw badRequest('برای حذف موعد، پیگیری مربوط را لغو یا زمان‌بندی مجدد کنید.');
        await client.query(`INSERT INTO crm_tasks(id,contact_id,title,assigned_to,due_at,priority,created_by)
          VALUES($1,$2,'پیگیری ارتباط',$3,$4,$5,$6)`,[randomUUID(),id,body.ownerUserId ?? before.owner_user_id ?? null,body.nextFollowupAt,body.priority ?? before.priority,actor.id]);
        await refreshFollowup(client,id);
      }
      await audit(client, actor.id, 'crm.relationship_updated', 'crm_contact', id, before, body, request.ip);
      return one(client,'SELECT * FROM crm_contacts WHERE id=$1',[id]);
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
      await validateOwner(client, body.assignedTo);
      await client.query('SELECT id FROM crm_contacts WHERE id=$1 FOR UPDATE',[id]);
      await client.query(`INSERT INTO crm_tasks(id,contact_id,title,description,assigned_to,due_at,priority,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [taskId,id,body.title,body.description,Object.prototype.hasOwnProperty.call(body,'assignedTo') ? body.assignedTo ?? null : contact.owner_user_id,body.dueAt ?? null,body.priority,actor.id]);
      await refreshFollowup(client,id);
      if(contact.user_id)await recordTimeline(client,{userId:contact.user_id,eventType:'crm.task_created',title:`پیگیری ثبت شد: ${body.title}`,source:'crm',refType:'crm_task',refId:taskId,actorId:actor.id});
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
      await validateOwner(client, body.assignedTo);
      const taskContact = await one<{contact_id:string}>(client,'SELECT contact_id FROM crm_tasks WHERE id=$1',[id]);
      if (!taskContact) throw notFound();
      await client.query('SELECT id FROM crm_contacts WHERE id=$1 FOR UPDATE',[taskContact.contact_id]);
      const before=await one<Record<string,unknown>>(client,'SELECT * FROM crm_tasks WHERE id=$1 FOR UPDATE',[id]);
      if(!before) throw notFound();
      const row=await one<Record<string,unknown>>(client,`
        UPDATE crm_tasks SET title=COALESCE($2,title),description=COALESCE($3,description),
          assigned_to=CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_to END,
          due_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE due_at END,
          priority=COALESCE($8,priority),status=COALESCE($9,status),
          completed_at=CASE WHEN $9='done' THEN COALESCE(completed_at,now()) WHEN $9 IN ('open','cancelled') THEN NULL ELSE completed_at END,updated_at=now()
        WHERE id=$1 RETURNING *`,
        [id,body.title ?? null,body.description ?? null,Object.prototype.hasOwnProperty.call(body,'assignedTo'),body.assignedTo ?? null,
         Object.prototype.hasOwnProperty.call(body,'dueAt'),body.dueAt ?? null,body.priority ?? null,body.status ?? null]);
      const contactId = String((row ?? before).contact_id);
      if (body.status !== undefined || Object.prototype.hasOwnProperty.call(body,'dueAt')) {
        const next = await one<{ due_at: string | null }>(client,
          `SELECT min(due_at)::text AS due_at FROM crm_tasks WHERE contact_id=$1 AND status='open' AND due_at IS NOT NULL`,
          [contactId]);
        await client.query('UPDATE crm_contacts SET next_followup_at=$2,updated_at=now() WHERE id=$1',
          [contactId, next?.due_at ?? null]);
      }
      await audit(client,actor.id,'crm.task_updated','crm_task',id,before,body,request.ip);
      if(body.status&&body.status!==before.status) {
        const contact=await one<{user_id:string|null}>(client,'SELECT user_id FROM crm_contacts WHERE id=$1',[contactId]);
        if(contact?.user_id)await recordTimeline(client,{userId:contact.user_id,eventType:'crm.task_updated',title:`پیگیری ${body.status==='done'?'انجام شد':body.status==='cancelled'?'لغو شد':'بازگشایی شد'}: ${String(before.title)}`,source:'crm',refType:'crm_task',refId:id,actorId:actor.id});
      }
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
      await client.query('SELECT id FROM crm_contacts WHERE id=$1 FOR UPDATE',[id]);
      await client.query(`INSERT INTO crm_interactions(id,contact_id,channel,outcome,subject,body,occurred_at,next_followup_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,now()),$8,$9)`,
        [interactionId,id,body.channel,body.outcome,body.subject,body.body,body.occurredAt ?? null,body.nextFollowupAt ?? null,actor.id]);
      await client.query(`UPDATE crm_contacts SET last_interaction_at=GREATEST(last_interaction_at,COALESCE($2::timestamptz,now())),updated_at=now() WHERE id=$1`,
        [id,body.occurredAt ?? null]);
      if (body.nextFollowupAt) {
        const owner = await one<{ owner_user_id: string | null }>(client,'SELECT owner_user_id FROM crm_contacts WHERE id=$1',[id]);
        await client.query(`INSERT INTO crm_tasks(id,contact_id,title,description,assigned_to,due_at,priority,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'normal',$7)`,
          [randomUUID(),id,`پیگیری: ${body.subject}`,body.body,owner?.owner_user_id ?? null,body.nextFollowupAt,actor.id]);
      }
      await refreshFollowup(client,id);
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
