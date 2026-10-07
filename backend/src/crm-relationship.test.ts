import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled=!!process.env.TEST_DATABASE_URL;
const config:Config={
  NODE_ENV:'test',PORT:4027,DATABASE_URL:process.env.TEST_DATABASE_URL??'postgres://127.0.0.1:1/none',
  REDIS_URL:undefined,JWT_SECRET:'test-secret-that-is-at-least-thirty-two-characters',PG_POOL_MAX:1,
  PUBLIC_ORIGIN:'http://127.0.0.1:5173',PAYMENT_WEBHOOK_SECRET:undefined,COOKIE_SECURE:'false',
};

test('CRM relationship flow: lead → follow-up → interaction → canonical account merge',{skip:!enabled},async()=>{
  const app=await buildApp(config);
  const pool=createPool(config);
  try{
    const suffix=randomUUID().slice(0,8);
    const adminId=randomUUID();
    const adminEmail=`crm-rel-admin-${suffix}@example.test`;
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',
      [adminId,adminEmail,await argon2.hash('AdminPassword123456!'),'مدیر ارتباط']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'admin')",[adminId]);
    const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{identity:adminEmail,password:'AdminPassword123456!'}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:`Bearer ${String(login.json().accessToken)}`};

    const phone=`09${String(Date.now()).slice(-9)}`;
    const lead=await app.inject({method:'POST',url:'/api/v1/admin/crm/leads',headers,payload:{
      name:`سرنخ ${suffix}`,phone,priority:'high',nextFollowupAt:new Date(Date.now()+86_400_000).toISOString(),
    }});
    assert.equal(lead.statusCode,201,lead.body);
    const contactId=String(lead.json().id);

    const duplicate=await app.inject({method:'POST',url:'/api/v1/admin/crm/leads',headers,payload:{name:'تکراری',phone}});
    assert.equal(duplicate.statusCode,409,duplicate.body);

    const search=await app.inject({method:'GET',url:`/api/v1/admin/crm/search?q=${encodeURIComponent(phone)}`,headers});
    assert.equal(search.statusCode,200,search.body);
    assert.ok((search.json().items as Array<Record<string,unknown>>).some((row)=>row.contact_id===contactId));

    const task=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${contactId}/tasks`,headers,payload:{
      title:'تماس اولیه',dueAt:new Date(Date.now()+3_600_000).toISOString(),priority:'urgent',
    }});
    assert.equal(task.statusCode,201,task.body);

    const interaction=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${contactId}/interactions`,headers,payload:{
      channel:'call',outcome:'follow_up',subject:'تماس معرفی',body:'نیازمند تماس مجدد',
      nextFollowupAt:new Date(Date.now()+7_200_000).toISOString(),
    }});
    assert.equal(interaction.statusCode,201,interaction.body);

    const note=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${contactId}/notes`,headers,payload:{body:'یادداشت داخلی سرنخ'}});
    assert.equal(note.statusCode,201,note.body);

    const dossier=await app.inject({method:'GET',url:`/api/v1/admin/crm/contacts/${contactId}/relationship`,headers});
    assert.equal(dossier.statusCode,200,dossier.body);
    assert.ok((dossier.json().tasks as unknown[]).length>=2,'interaction follow-up enters canonical task queue');
    assert.equal((dossier.json().notes as unknown[]).length,1);

    const userId=randomUUID();
    const userEmail=`crm-rel-user-${suffix}@example.test`;
    await pool.query('INSERT INTO users(id,email,phone,password_hash,display_name) VALUES($1,$2,$3,$4,$5)',
      [userId,userEmail,phone,await argon2.hash('CustomerPassword123!'),`مشتری ${suffix}`]);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'customer')",[userId]);

    const linked=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${contactId}/link-user`,headers,payload:{userId}});
    assert.equal(linked.statusCode,200,linked.body);
    assert.equal(String(linked.json().user_id),userId);

    const userRel=await app.inject({method:'GET',url:`/api/v1/admin/crm/users/${userId}/relationship`,headers});
    assert.equal(userRel.statusCode,200,userRel.body);
    assert.equal(String(userRel.json().contact.user_id),userId);

    const queue=await app.inject({method:'GET',url:'/api/v1/admin/crm/action-center?view=all',headers});
    assert.equal(queue.statusCode,200,queue.body);
    assert.ok((queue.json().items as Array<Record<string,unknown>>).some((row)=>row.contact_id===String(userRel.json().contact.id)));
  }finally{
    await app.close();
    await pool.end();
  }
});

test('CRM relationship invariants and access boundaries', {skip:!enabled}, async (t) => {
  const app = await buildApp(config);
  const pool = createPool(config);
  const suffix = randomUUID().slice(0,8);
  const adminId = randomUUID();
  const email = `crm-invariants-${suffix}@example.test`;
  try {
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',
      [adminId,email,await argon2.hash('AdminPassword123456!'),'مسئول ارتباط']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'admin')",[adminId]);
    const login = await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{identity:email,password:'AdminPassword123456!'}});
    assert.equal(login.statusCode,200,login.body);
    const headers = {authorization:`Bearer ${login.json().accessToken}`};
    const create = async (payload: Record<string,unknown>) => {
      const response = await app.inject({method:'POST',url:'/api/v1/admin/crm/leads',headers,payload:{name:`مخاطب ${suffix}`,...payload}});
      assert.equal(response.statusCode,201,response.body);
      return String(response.json().id);
    };
    const relationship = async (id: string) => {
      const response = await app.inject({method:'GET',url:`/api/v1/admin/crm/contacts/${id}/relationship`,headers});
      assert.equal(response.statusCode,200,response.body);
      return response.json();
    };
    await t.test('lead date persists as an actionable task',async()=>{
      const due = new Date(Date.now()+86_400_000).toISOString();
      const id = await create({nextFollowupAt:due,ownerUserId:adminId});
      const detail = await relationship(id);
      assert.equal(detail.tasks.length,1);
      assert.equal(new Date(detail.tasks[0].due_at).toISOString(),due);
      assert.equal(detail.tasks[0].assigned_to,adminId);
    });
    await t.test('later and historical interactions preserve earliest task and latest interaction',async()=>{
      const id = await create({});
      const early = new Date(Date.now()+3_600_000).toISOString();
      const task = await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/tasks`,headers,payload:{title:'پیگیری نزدیک',dueAt:early}});
      assert.equal(task.statusCode,201,task.body);
      const recent = new Date().toISOString();
      for (const occurredAt of [recent,new Date(Date.now()-86_400_000).toISOString()]) {
        const response = await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/interactions`,headers,
          payload:{channel:'call',outcome:'follow_up',subject:'تماس',occurredAt,nextFollowupAt:new Date(Date.now()+7_200_000).toISOString()}});
        assert.equal(response.statusCode,201,response.body);
      }
      const detail = await relationship(id);
      assert.equal(new Date(detail.contact.next_followup_at).toISOString(),early);
      assert.equal(new Date(detail.contact.last_interaction_at).toISOString(),recent);
      const complete = await app.inject({method:'PATCH',url:`/api/v1/admin/crm/tasks/${task.json().id}`,headers,payload:{status:'done'}});
      assert.equal(complete.statusCode,200,complete.body);
      const after = await relationship(id);
      assert.ok(new Date(after.contact.next_followup_at).getTime()>new Date(early).getTime());
    });
    await t.test('phone normalization detects international and Persian-digit duplicates',async()=>{
      const phone = `091${String(Date.now()).slice(-8)}`;
      await create({phone});
      for (const candidate of [`+98${phone.slice(1)}`,phone.replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[Number(d)]!)]) {
        const response = await app.inject({method:'POST',url:'/api/v1/admin/crm/leads',headers,payload:{name:'تکراری',phone:candidate}});
        assert.equal(response.statusCode,409,response.body);
      }
    });
    await t.test('platform identity without CRM contact prevents a duplicate lead',async()=>{
      const userId = randomUUID();
      const userEmail = `identity-${suffix}@example.test`;
      await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[userId,userEmail,await argon2.hash('CustomerPassword123!'),'حساب واقعی']);
      const response = await app.inject({method:'POST',url:'/api/v1/admin/crm/leads',headers,payload:{name:'تکراری',email:userEmail.toUpperCase()}});
      assert.equal(response.statusCode,409,response.body);
    });
    await t.test('anonymous and ordinary accounts cannot manage relationships',async()=>{
      const anonymous = await app.inject({method:'GET',url:'/api/v1/admin/crm/search?q=test'});
      assert.equal(anonymous.statusCode,401);
      const userId = randomUUID();
      const userEmail = `unauthorized-${suffix}@example.test`;
      await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[userId,userEmail,await argon2.hash('CustomerPassword123!'),'مشتری']);
      await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'customer')",[userId]);
      const session = await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{identity:userEmail,password:'CustomerPassword123!'}});
      assert.equal(session.statusCode,200,session.body);
      const response = await app.inject({method:'POST',url:'/api/v1/admin/crm/leads',headers:{authorization:`Bearer ${session.json().accessToken}`},payload:{name:'مخاطب'}});
      assert.equal(response.statusCode,403,response.body);
    });
    await t.test('search does not create relationship rows and enforces query limits',async()=>{
      const before = await pool.query('SELECT count(*)::int AS count FROM crm_contacts');
      const response = await app.inject({method:'GET',url:`/api/v1/admin/crm/search?q=${suffix}&limit=1`,headers});
      assert.equal(response.statusCode,200,response.body);
      assert.ok(response.json().items.length<=1);
      const after = await pool.query('SELECT count(*)::int AS count FROM crm_contacts');
      assert.equal(after.rows[0].count,before.rows[0].count);
      const short = await app.inject({method:'GET',url:'/api/v1/admin/crm/search?q=a',headers});
      assert.equal(short.statusCode,400);
    });
    await t.test('owner validation, audit, rescheduling, completion and reopening',async()=>{
      const id=await create({});
      const assign=await app.inject({method:'PATCH',url:`/api/v1/admin/crm/contacts/${id}/relationship`,headers,payload:{ownerUserId:adminId}});
      assert.equal(assign.statusCode,200,assign.body);
      const invalid=await app.inject({method:'PATCH',url:`/api/v1/admin/crm/contacts/${id}/relationship`,headers,payload:{ownerUserId:randomUUID()}});
      assert.equal(invalid.statusCode,400,invalid.body);
      const due=new Date(Date.now()-3_600_000).toISOString();
      const task=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/tasks`,headers,payload:{title:'تماس',dueAt:due,assignedTo:adminId}});
      assert.equal(task.statusCode,201,task.body);
      const queue=await app.inject({method:'GET',url:`/api/v1/admin/crm/action-center?view=overdue&ownerId=${adminId}`,headers});
      assert.ok(queue.json().items.some((row:{id:string})=>row.id===task.json().id));
      const next=new Date(Date.now()+86_400_000).toISOString();
      for(const payload of [{dueAt:next},{status:'done'},{status:'open'},{status:'cancelled'}]) {
        const response=await app.inject({method:'PATCH',url:`/api/v1/admin/crm/tasks/${task.json().id}`,headers,payload});
        assert.equal(response.statusCode,200,response.body);
        const detail=await relationship(id);
        if(payload.status==='done'||payload.status==='cancelled')assert.equal(detail.contact.next_followup_at,null);
        else assert.equal(new Date(detail.contact.next_followup_at).toISOString(),next);
        if(payload.status==='open'||payload.status==='cancelled')assert.equal(response.json().completed_at,null);
      }
      const audit=await pool.query("SELECT 1 FROM audit_logs WHERE resource_id=$1 AND action='crm.relationship_updated'",[id]);
      assert.ok(audit.rowCount);
    });
    await t.test('merge preserves notes, interactions, tasks, labels and legacy history',async()=>{
      const id=await create({});
      const userId=randomUUID();
      await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[userId,`merge-${suffix}@example.test`,await argon2.hash('CustomerPassword123!'),'حساب مقصد']);
      const target=await app.inject({method:'GET',url:`/api/v1/admin/crm/users/${userId}/relationship`,headers});
      assert.equal(target.statusCode,200,target.body);
      const targetId=String(target.json().contact.id);
      await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/notes`,headers,payload:{body:'یادداشت حفظ شود'}});
      await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/interactions`,headers,payload:{channel:'call',outcome:'follow_up',subject:'تعامل حفظ شود',nextFollowupAt:new Date(Date.now()+3_600_000).toISOString()}});
      const label=await pool.query('SELECT code FROM crm_labels LIMIT 1');
      const assigned=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/labels`,headers,payload:{labelCode:label.rows[0].code}});
      assert.equal(assigned.statusCode,201,assigned.body);
      assert.equal((await relationship(id)).labels.length,1);
      await pool.query("INSERT INTO crm_activities(id,contact_id,type,title,body) VALUES($1,$2,'note','یادداشت قدیمی','متن قبلی')",[randomUUID(),id]);
      const merge=await app.inject({method:'POST',url:`/api/v1/admin/crm/contacts/${id}/link-user`,headers,payload:{userId}});
      assert.equal(merge.statusCode,200,merge.body);
      assert.equal(merge.json().id,targetId);
      const detail=await relationship(targetId);
      assert.equal(detail.notes.length,1);assert.equal(detail.tasks.length,1);assert.equal(detail.interactions.length,1);
      assert.ok(detail.contact.last_interaction_at);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM crm_contact_labels WHERE contact_id=$1',[targetId])).rows[0].count,1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM crm_activities WHERE contact_id=$1',[targetId])).rows[0].count,1);
      assert.equal((await pool.query('SELECT id FROM crm_contacts WHERE id=$1',[id])).rowCount,0);
      const timeline=await pool.query("SELECT title FROM customer_timeline WHERE user_id=$1 AND ref_type='crm_interaction'",[userId]);
      assert.ok(timeline.rows.some(row=>row.title==='تعامل حفظ شود'));
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
