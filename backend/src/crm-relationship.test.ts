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
