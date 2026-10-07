import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import type { Config } from './config.js';
import { publicationDiff, type DraftPage } from './cms-workspace.js';

test('human publication differences summarize content, order, visibility and removal',()=>{
  const section={id:'s',component_code:'hero',title:'هیرو',payload:{title:'old',limit:4},visible:true,position:1,variant:'default',section_theme:'inherit',style_overrides:{},responsive_config:{}};
  const draft:DraftPage={id:'page',description:'',draft_revision:1,status:'draft',title:'new',path:'/new',sections:[{...section,payload:{title:'new',limit:8},visible:false,position:2}]};
  const diff=publicationDiff(draft,{title:'old',path:'/old',sections_snapshot:[section,{...section,id:'removed',title:'پرسش‌ها'}]});
  assert.ok(diff.includes('عنوان صفحه تغییر کرده'));assert.ok(diff.includes('مسیر صفحه تغییر کرده'));
  assert.ok(diff.includes('هیرو: عنوان تغییر کرده'));assert.ok(diff.includes('هیرو: تعداد آیتم تغییر کرده'));
  assert.ok(diff.includes('هیرو: ترتیب تغییر کرده'));assert.ok(diff.includes('هیرو: نمایش تغییر کرده'));assert.ok(diff.includes('پرسش‌ها: حذف شده'));
});

test('CMS production lifecycle: persisted drafts, publication isolation and boundaries',{skip:!process.env.TEST_DATABASE_URL},async(t)=>{
  const config:Config={NODE_ENV:'test',PORT:4019,DATABASE_URL:process.env.TEST_DATABASE_URL!,JWT_SECRET:'cms-production-secret-at-least-thirty-two-characters',PG_POOL_MAX:1,PUBLIC_ORIGIN:'http://127.0.0.1:5173',COOKIE_SECURE:'false'};
  const pool=createPool(config),app=await buildApp(config);const suffix=randomUUID().slice(0,8),code=`cms-${suffix}`,path=`/cms/${suffix}`;
  try{
    const user=async(role:string)=>{const id=randomUUID(),email=`${role}-${suffix}@example.test`;await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[id,email,await argon2.hash('CmsPassword-123456!'),role]);await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)',[id,role]);const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{identity:email,password:'CmsPassword-123456!'}});return{id,headers:{authorization:`Bearer ${login.json().accessToken}`}};};
    const admin=await user('admin'),customer=await user('customer');
    const call=async(method:'GET'|'POST'|'PUT',route:string,payload?:unknown,headers=admin.headers)=>{const r=await app.inject({method,url:`/api/v1${route}`,headers,payload:payload as never});return r;};
    let id='',draft:DraftPage,firstVersion=0;
    await t.test('authentication and read/edit/publish server permissions',async()=>{
      assert.equal((await app.inject({method:'GET',url:'/api/v1/admin/cms/overview'})).statusCode,401);
      assert.equal((await call('GET','/admin/cms/overview',undefined,customer.headers)).statusCode,403);
      const r=await call('POST','/admin/cms/landing-pages',{code,title:'صفحه آزمایش',path,pageType:'generic',template:'blank'});assert.equal(r.statusCode,201,r.body);id=r.json().id;
      assert.equal((await call('POST',`/admin/cms/pages/${id}/publish`,{},customer.headers)).statusCode,403);
      assert.equal((await call('GET',`/admin/cms/pages/${id}/draft`,undefined,customer.headers)).statusCode,403);
    });
    await t.test('new pages are draft-only and templates persist real starter sections',async()=>{
      assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404);
      const r=await call('POST','/admin/cms/landing-pages',{code:`lead-${suffix}`,title:'عضویت آزمایش',path:`/lead/${suffix}`,pageType:'lead_generation',template:'lead'});assert.equal(r.statusCode,201,r.body);
      const d=(await call('GET',`/admin/cms/pages/${r.json().id}/draft`)).json();assert.equal(d.status,'draft');assert.ok(d.sections.some((s:{component_code:string})=>s.component_code==='lead_form'));
      draft=(await call('GET',`/admin/cms/pages/${id}/draft`)).json();
    });
    const save=async(next:DraftPage)=>{const r=await call('PUT',`/admin/cms/pages/${id}/draft`,{expectedRevision:next.draft_revision,title:next.title,path:next.path,description:next.description,sections:next.sections.map(({id,component_code,title,payload,visible,position,variant,section_theme,style_overrides,responsive_config})=>({id,component_code,title,payload,visible,position,variant,section_theme,style_overrides,responsive_config}))});return r;};
    await t.test('atomic draft add/edit persists without creating a publication',async()=>{
      draft.sections=[{id:randomUUID(),component_code:'hero',title:'هیرو آزمایش',payload:{title:'نسخه اول',ctaTarget:'shop'},visible:true,position:1,variant:'split',section_theme:'inherit',style_overrides:{},responsive_config:{}}];
      const r=await save(draft);assert.equal(r.statusCode,200,r.body);draft=r.json();assert.ok(draft.draft_revision>1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM cms_page_versions WHERE page_id=$1',[id])).rows[0].n,0);
      assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404);
      const preview=await call('GET',`/admin/cms/pages/${id}/preview`);assert.equal(preview.statusCode,200);assert.equal(preview.json().sections[0].payload.title,'نسخه اول');
    });
    await t.test('readiness and explicit publication freeze a snapshot and audit actor',async()=>{
      const health=await call('GET',`/admin/cms/pages/${id}/readiness`);assert.equal(health.statusCode,200,health.body);assert.deepEqual(health.json().errors,[]);
      const published=await call('POST',`/admin/cms/pages/${id}/publish`,{expectedRevision:draft.draft_revision,changeSummary:'اول'});assert.equal(published.statusCode,200,published.body);firstVersion=published.json().version;
      const live=await call('GET',`/site/pages/${code}`);assert.equal(live.statusCode,200,live.body);assert.equal(live.json().sections[0].payload.title,'نسخه اول');
      assert.ok((await pool.query("SELECT id FROM audit_logs WHERE resource_id=$1 AND action='cms.page_published'",[id])).rowCount);
    });
    await t.test('editing published title/path/content never changes the public snapshot',async()=>{
      draft={...draft,title:'عنوان پیش‌نویس',path:`${path}-draft`,sections:draft.sections.map(s=>({...s,payload:{...s.payload,title:'نسخه دوم'}}))};
      const r=await save(draft);assert.equal(r.statusCode,200,r.body);draft=r.json();
      const live=(await call('GET',`/site/pages/${code}`)).json();assert.equal(live.title,'صفحه آزمایش');assert.equal(live.path,path);assert.equal(live.sections[0].payload.title,'نسخه اول');
      assert.equal((await call('GET',`/site/resolve-path?path=${path}-draft`)).statusCode,404);
      assert.equal((await call('GET',`/site/resolve-path?path=${path}`)).json().code,code);
      const seo=await call('GET',`/seo/page/${code}`);assert.equal(seo.statusCode,200,seo.body);assert.ok(!seo.body.includes('عنوان پیش‌نویس')&&!seo.body.includes(`${path}-draft`));
      const sitemap=await call('GET','/seo/sitemap.xml');assert.ok(sitemap.body.includes(path));assert.ok(!sitemap.body.includes(`${path}-draft`));
      const h=(await call('GET',`/admin/cms/pages/${id}/readiness`)).json();assert.ok(h.diff.some((d:string)=>d.includes('عنوان')));
    });
    await t.test('stale draft writes and stale publication checks are rejected',async()=>{
      const stale={...draft,draft_revision:draft.draft_revision-1};assert.equal((await save(stale)).statusCode,409);
      assert.equal((await call('POST',`/admin/cms/pages/${id}/publish`,{expectedRevision:stale.draft_revision})).statusCode,409);
      const legacy=await app.inject({method:'PATCH',url:`/api/v1/admin/cms/sections/${draft.sections[0]!.id}`,headers:admin.headers,payload:{title:'عنوان بخش جدید'}});assert.equal(legacy.statusCode,200);
      assert.equal((await save(draft)).statusCode,409,'legacy writes also invalidate canonical optimistic revision');draft=(await call('GET',`/admin/cms/pages/${id}/draft`)).json();
    });
    await t.test('critical missing references block publication; invalid schema and paths roll back',async()=>{
      const invalid=await save({...draft,path:'javascript:bad'});assert.equal(invalid.statusCode,400);
      const badSchema=await save({...draft,sections:draft.sections.map(s=>({...s,payload:{title:'<script>x</script>'}}))});assert.equal(badSchema.statusCode,400);
      const r=await save({...draft,sections:draft.sections.map(s=>({...s,payload:{title:'دوم',ctaTarget:'page:missing-page'}}))});assert.equal(r.statusCode,200,r.body);draft=r.json();
      const health=(await call('GET',`/admin/cms/pages/${id}/readiness`)).json();assert.equal(health.ready,false);assert.ok(health.errors.length);
      assert.equal((await call('POST',`/admin/cms/pages/${id}/publish`,{expectedRevision:draft.draft_revision})).statusCode,400);
      const target=await call('POST','/admin/cms/landing-pages',{code:`target-${suffix}`,title:'صفحه مقصد پیش‌نویس',path:`/target/${suffix}`,pageType:'generic',template:'blank'});assert.equal(target.statusCode,201,target.body);
      draft=(await save({...draft,sections:draft.sections.map(s=>({...s,payload:{title:'دوم',ctaTarget:`page:target-${suffix}`}}))})).json();
      assert.equal((await call('GET',`/admin/cms/pages/${id}/readiness`)).json().ready,false,'existing unpublished targets are unavailable');
      const fixed=await save({...draft,sections:draft.sections.map(s=>({...s,payload:{title:'نسخه دوم',ctaTarget:'shop'}}))});draft=fixed.json();
    });
    await t.test('future scheduling preserves current publication until its start',async()=>{
      const r=await call('POST',`/admin/cms/pages/${id}/publish`,{expectedRevision:draft.draft_revision,scheduledStartAt:new Date(Date.now()+3600000).toISOString(),scheduledEndAt:new Date(Date.now()+7200000).toISOString()});assert.equal(r.statusCode,200,r.body);
      const live=(await call('GET',`/site/pages/${code}`)).json();assert.equal(live.sections[0].payload.title,'نسخه اول');
      await pool.query("UPDATE cms_page_versions SET starts_at=now()-interval '1 minute' WHERE page_id=$1 AND version=$2",[id,r.json().version]);
      const arrived=(await call('GET',`/site/pages/${code}`)).json();assert.equal(arrived.sections[0].payload.title,'نسخه دوم');
      await pool.query("UPDATE cms_page_versions SET ends_at=now()-interval '1 second' WHERE page_id=$1 AND version=$2",[id,r.json().version]);
      assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404,'end does not resurrect the earlier publication');
      assert.equal((await call('POST',`/admin/cms/pages/${id}/publish`,{scheduledEndAt:new Date(Date.now()-10000).toISOString()})).statusCode,400);
    });
    await t.test('version preview and restore copy to draft, never publish',async()=>{
      const p=await call('GET',`/admin/cms/pages/${id}/versions/${firstVersion}/preview`);assert.equal(p.statusCode,200);assert.equal(p.json().sections[0].payload.title,'نسخه اول');
      const count=Number((await pool.query('SELECT count(*) AS n FROM cms_page_versions WHERE page_id=$1',[id])).rows[0].n);
      const r=await call('POST',`/admin/cms/pages/${id}/versions/${firstVersion}/restore`);assert.equal(r.statusCode,200,r.body);
      draft=(await call('GET',`/admin/cms/pages/${id}/draft`)).json();assert.equal(draft.sections[0]!.payload.title,'نسخه اول');assert.equal(draft.path,path);
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM cms_page_versions WHERE page_id=$1',[id])).rows[0].n),count);
      assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404);
    });
    await t.test('safe duplicate has independent draft identity and no history or schedule',async()=>{
      const r=await call('POST',`/admin/cms/pages/${id}/duplicate`,{title:'کپی صفحه',path:`/copy/${suffix}`});assert.equal(r.statusCode,201,r.body);const copy=(await call('GET',`/admin/cms/pages/${r.json().id}/draft`)).json();assert.equal(copy.status,'draft');assert.notEqual(copy.sections[0].id,draft.sections[0]!.id);
      const p=(await pool.query('SELECT * FROM cms_pages WHERE id=$1',[copy.id])).rows[0];assert.equal(p.scheduled_start_at,null);assert.equal((await call('GET',`/admin/cms/pages/${copy.id}/versions`)).json().items.length,0);
      const duplicate=await save({...draft,path:`/copy/${suffix}`});assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal((await call('POST',`/admin/cms/pages/${id}/publish`)).statusCode,400);draft=(await save({...duplicate.json(),path})).json();
    });
    await t.test('archive and restore cannot silently resurrect a live page',async()=>{
      assert.equal((await call('POST',`/admin/cms/pages/${id}/unpublish`,{archive:true})).statusCode,200);
      assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404);
      assert.equal((await call('POST',`/admin/cms/pages/${id}/unpublish`,{})).statusCode,200);assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404);
    });
    await t.test('section reorder/removal is persisted exclusively in drafts',async()=>{
      const extra={...draft.sections[0]!,id:randomUUID(),title:'دوم',position:2};draft=(await save({...draft,sections:[extra,draft.sections[0]!]})).json();assert.equal(draft.sections[0]!.title,'دوم');
      draft=(await save({...draft,sections:[draft.sections[1]!]})).json();assert.equal(draft.sections.length,1);assert.equal((await call('GET',`/site/pages/${code}`)).statusCode,404);
    });
    await t.test('journal drafts persist on server and leave previous publication unchanged',async()=>{
      const payload={postType:'article',slug:`journal-${suffix}`,title:'مطلب اول',body:'متن اول',status:'published'};
      const created=await call('POST','/admin/editorial',payload);assert.equal(created.statusCode,201,created.body);const post=created.json();
      const saved=await call('PUT',`/admin/editorial/${post.id}`,{...payload,title:'پیش‌نویس دوم',body:'متن دوم',status:'draft',expectedVersion:post.version});assert.equal(saved.statusCode,200,saved.body);
      const live=await call('GET',`/public/editorial/${payload.slug}`);assert.equal(live.json().title,'مطلب اول');assert.equal(live.json().body,'متن اول');
      assert.equal((await call('PUT',`/admin/editorial/${post.id}`,{...payload,expectedVersion:post.version})).statusCode,409);
      const moved=await call('PUT',`/admin/editorial/${post.id}`,{...payload,slug:`${payload.slug}-draft`,status:'draft',expectedVersion:saved.json().version});assert.equal(moved.statusCode,200,moved.body);
      const collision=await call('POST','/admin/editorial',{...payload,title:'مطلب با نشانی متداخل'});assert.equal(collision.statusCode,409,'live slug remains reserved while its working copy changes');
      assert.equal((await call('GET',`/public/editorial/${payload.slug}`)).json().title,'مطلب اول');
      const published=await call('PUT',`/admin/editorial/${post.id}`,{...payload,title:'مطلب دوم',body:'متن دوم',expectedVersion:moved.json().version});assert.equal(published.statusCode,200,published.body);
      assert.equal((await call('GET',`/public/editorial/${payload.slug}`)).json().title,'مطلب دوم');
      assert.equal((await call('PUT',`/admin/editorial/${post.id}`,{...payload,status:'archived',expectedVersion:published.json().version})).statusCode,200);assert.equal((await call('GET',`/public/editorial/${payload.slug}`)).statusCode,404);
      const archived=(await call('GET',`/admin/editorial?q=${payload.slug}`)).json().items.find((p:{id:string})=>p.id===post.id)
        ?? (await call('GET','/admin/editorial')).json().items.find((p:{id:string})=>p.id===post.id);
      assert.equal((await call('PUT',`/admin/editorial/${post.id}`,{...payload,status:'draft',expectedVersion:archived.version})).statusCode,200);
      assert.equal((await call('GET',`/public/editorial/${payload.slug}`)).statusCode,404,'restore to draft does not enable the previous publication');
    });
    await t.test('global content persists and overview returns real bounded data',async()=>{
      const layout=await call('GET','/admin/cms/layout');assert.equal(layout.statusCode,200);
      const saved=await call('PUT','/admin/cms/layout/global_footer',{...layout.json().footer,brandTitle:'برند آزمایش'});assert.equal(saved.statusCode,200,saved.body);assert.equal((await call('GET','/site/layout')).json().footer.brandTitle,'برند آزمایش');
      const overview=await call('GET','/admin/cms/overview');assert.equal(overview.statusCode,200);assert.ok(overview.json().counts.some((c:{count:number})=>c.count>0));assert.ok(overview.json().recent.length<=8);
    });
  }finally{await app.close();await pool.end();}
});
