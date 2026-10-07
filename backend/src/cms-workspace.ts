import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { responsiveConfigSchema, validateSectionPayload, validateStyleOverrides, type FieldSchema } from './cms-schema.js';

type Queryable = Pick<DbPool, 'query'>;
export type DraftSection = { id: string; component_code: string; title: string; payload: Record<string, unknown>; visible: boolean; position: number; variant: string; section_theme: string; style_overrides: Record<string, unknown>; responsive_config: Record<string, unknown> };
export type DraftPage = { id: string; title: string; path: string; description: string; draft_revision: number; status: string; sections: DraftSection[] };
export async function readDraft(db: Queryable, id: string): Promise<DraftPage> {
  const page = await one<Omit<DraftPage, 'sections'>>(db, 'SELECT * FROM cms_pages WHERE id=$1', [id]);
  if (!page) throw notFound();
  const sections = await db.query<DraftSection>(`SELECT s.*, c.code AS component_code,c.component_type,c.field_schema,c.active AS component_active
    FROM cms_sections s JOIN cms_components c ON c.id=s.component_id WHERE s.page_id=$1 ORDER BY s.position,s.created_at`, [id]);
  return { ...page, sections: sections.rows };
}
export async function liveSnapshot(db: Queryable, id: string) {
  // Choose the latest publication whose start has arrived, then check its end. An expired latest
  // publication hides the page; it must not resurrect an older publication.
  return one<Record<string, unknown> & { sections_snapshot: DraftSection[]; version: number; title: string; path: string; active: boolean; ends_at: string | null }>(db,
    `SELECT * FROM cms_page_versions WHERE page_id=$1 AND status IN ('published','scheduled')
      AND (starts_at IS NULL OR starts_at<=now()) ORDER BY version DESC LIMIT 1`, [id]);
}
export function publicationDiff(draft: DraftPage, published: { title: string; path: string; sections_snapshot: DraftSection[] } | null) {
  if (!published) return ['اولین انتشار این صفحه'];
  const changes: string[] = [];
  if (draft.title !== published.title) changes.push('عنوان صفحه تغییر کرده');
  if (draft.path !== published.path) changes.push('مسیر صفحه تغییر کرده');
  const old = published.sections_snapshot;
  for (const s of draft.sections) {
    const before = old.find((p) => p.id === s.id);
    const label = s.title || 'بخش';
    if (!before) { changes.push(`${label}: بخش افزوده شده`); continue; }
    if (s.visible !== before.visible) changes.push(`${label}: نمایش تغییر کرده`);
    if (s.position !== before.position) changes.push(`${label}: ترتیب تغییر کرده`);
    const keys = new Set([...Object.keys(s.payload), ...Object.keys(before.payload)]);
    const labels: Record<string,string> = { title:'عنوان', subtitle:'زیرعنوان', image:'تصویر', body:'متن', text:'متن', limit:'تعداد آیتم', ctaLabel:'متن دکمه', ctaTarget:'مقصد', items:'آیتم‌ها', questions:'پرسش‌ها' };
    for (const k of keys) if (JSON.stringify(s.payload[k]) !== JSON.stringify(before.payload[k])) changes.push(`${label}: ${labels[k] ?? 'محتوا'} تغییر کرده`);
    if (s.variant !== before.variant || JSON.stringify(s.style_overrides) !== JSON.stringify(before.style_overrides) || JSON.stringify(s.responsive_config) !== JSON.stringify(before.responsive_config)) changes.push(`${label}: چیدمان یا ظاهر تغییر کرده`);
  }
  for (const s of old) if (!draft.sections.some((p) => p.id === s.id)) changes.push(`${s.title || 'بخش'}: حذف شده`);
  return [...new Set(changes)];
}
export async function checkDraft(db: Queryable, draft: DraftPage) {
  const errors: string[] = []; const warnings: string[] = [];
  if (!/^\/[a-z0-9/_-]{0,120}$/.test(draft.path)) errors.push('مسیر صفحه معتبر نیست');
  if (await one(db, 'SELECT id FROM cms_pages WHERE path=$1 AND id<>$2 LIMIT 1',[draft.path,draft.id])) errors.push('مسیر صفحه تکراری است');
  if(await one(db,`SELECT v.id FROM cms_page_versions v JOIN cms_pages p ON p.id=v.page_id WHERE v.path=$1 AND p.id<>$2 AND p.status IN ('published','scheduled') AND v.active AND (v.starts_at IS NULL OR v.starts_at<=now()) AND (v.ends_at IS NULL OR v.ends_at>now()) AND v.version=(SELECT max(last.version) FROM cms_page_versions last WHERE last.page_id=p.id AND (last.starts_at IS NULL OR last.starts_at<=now())) LIMIT 1`,[draft.path,draft.id]))errors.push('مسیر با نسخه زنده صفحه دیگری تداخل دارد');
  if (!draft.sections.some((s) => s.visible)) warnings.push('صفحه بخش قابل نمایش ندارد');
  for (const s of draft.sections.filter((s) => s.visible)) {
    const c = await one<{field_schema:FieldSchema;active:boolean}>(db,'SELECT field_schema,active FROM cms_components WHERE code=$1',[s.component_code]);
    if (!c?.active) { errors.push(`${s.title}: نوع بخش در دسترس نیست`); continue; }
    try { validateSectionPayload(c.field_schema,s.payload); validateStyleOverrides(s.style_overrides ?? {}); responsiveConfigSchema.parse(s.responsive_config ?? {}); }
    catch(e) { errors.push(`${s.title}: ${e instanceof Error ? e.message : 'محتوا معتبر نیست'}`); }
    const refs: [string,string,string][] = [];
    for (const f of c.field_schema.fields ?? []) {
      const value = s.payload[f.key];
      if (!value) continue;
      if (f.type==='product') refs.push(['products','id',String(value)]);
      if (f.type==='collection') refs.push(['cms_collections','code',String(value)]);
      if (f.type==='campaign') refs.push(['festivals','id',String(value)]);
      if (f.type==='target' && typeof value==='string') {
        const [kind,key]=value.split(':');
        if (kind==='page' && key) refs.push(['cms_pages','code',key]);
        if (kind==='product' && key) refs.push(['products','id',key]);
        if (kind==='collection' && key) refs.push(['cms_collections','code',key]);
      }
      if ((f.type==='media'||f.type==='video') && String(value).startsWith('/api/v1/media/')) refs.push(['files','id',String(value).split('/')[4]!.split('?')[0]!]);
    }
    for (const key of ['productId','collectionCode','campaignId']) {
      const value=s.payload[key]; if(value) refs.push([key==='productId'?'products':key==='collectionCode'?'cms_collections':'festivals',key==='collectionCode'?'code':'id',String(value)]);
    }
    for(const id of Array.isArray(s.payload.productIds)?s.payload.productIds:[]) refs.push(['products','id',String(id)]);
    for(const [table,column,value] of refs) {
      // Identifiers originate solely from the fixed mapping above; reference values are parameterized.
      const row=await one<{id?:string;status?:string;active?:boolean}>(db,`SELECT * FROM ${table} WHERE ${column}::text=$1 LIMIT 1`,[value]);
      if(!row) { errors.push(`${s.title}: مقصد یا مرجع محتوا پیدا نشد`); continue; }
      if((table==='products'&&row.status!=='published')||((table==='cms_collections'||table==='festivals')&&!row.active)) errors.push(`${s.title}: مرجع محتوا غیرفعال است`);
      if(table==='cms_pages'&&row.id!==draft.id) {
        const target=await liveSnapshot(db,row.id!);
        if(!['published','scheduled'].includes(row.status??'')||!target?.active||(target.ends_at&&new Date(target.ends_at).getTime()<=Date.now())) errors.push(`${s.title}: صفحه مقصد منتشر نشده یا در دسترس نیست`);
      }
    }
  }
  const live=await liveSnapshot(db,draft.id);
  return { revision:draft.draft_revision, errors:[...new Set(errors)],warnings,diff:publicationDiff(draft,live),ready:errors.length===0 };
}
const section=z.object({id:z.uuid(),component_code:z.string().regex(/^[a-z0-9_]{2,40}$/),title:z.string().max(160),payload:z.record(z.string(),z.unknown()),visible:z.boolean(),position:z.number().int(),variant:z.string().default('default'),section_theme:z.enum(['inherit','light','dark','campaign']).default('inherit'),style_overrides:z.record(z.string(),z.unknown()).default({}),responsive_config:z.record(z.string(),z.unknown()).default({})});
export function registerCmsWorkspaceRoutes(app: FastifyInstance,pool:DbPool,config:Config) {
  const actor=async(request:Parameters<typeof principal>[0],permission:string)=>{const user=await principal(request,pool,config);requirePermission(user,permission);return user;};
  app.get('/api/v1/admin/cms/overview',async(request)=>{
    await actor(request,'cms:read');
    const pages=await pool.query(`SELECT status,count(*)::int AS count FROM cms_pages GROUP BY status`);
    const recent=await pool.query('SELECT id,title,status,updated_at FROM cms_pages ORDER BY updated_at DESC LIMIT 8');
    const upcoming=await pool.query(`SELECT title,starts_at FROM cms_page_versions WHERE starts_at>now() AND EXISTS(SELECT 1 FROM cms_pages p WHERE p.id=cms_page_versions.page_id AND p.status IN ('published','scheduled')) AND version=(SELECT max(v.version) FROM cms_page_versions v WHERE v.page_id=cms_page_versions.page_id) ORDER BY starts_at LIMIT 8`);
    return {counts:pages.rows,recent:recent.rows,upcoming:upcoming.rows};
  });
  app.get('/api/v1/admin/cms/pages/:id/draft',async(request)=>{const user=await actor(request,'cms:read');const{id}=z.object({id:z.uuid()}).parse(request.params);return {...await readDraft(pool,id),permissions:user.permissions};});
  app.get('/api/v1/admin/cms/pages/:id/readiness',async(request)=>{await actor(request,'cms:read');const{id}=z.object({id:z.uuid()}).parse(request.params);return checkDraft(pool,await readDraft(pool,id));});
  app.put('/api/v1/admin/cms/pages/:id/draft',async(request)=>{
    const user=await actor(request,'cms:edit');const{id}=z.object({id:z.uuid()}).parse(request.params);
    const b=z.object({expectedRevision:z.number().int().positive(),title:z.string().trim().min(2).max(160),path:z.string().regex(/^\/[a-z0-9/_-]{0,120}$/),description:z.string().max(1000),sections:z.array(section).max(200)}).strict().parse(request.body);
    return transaction(pool,async(client)=>{
      const page=await one<{draft_revision:number}>(client,'SELECT draft_revision FROM cms_pages WHERE id=$1 FOR UPDATE',[id]);if(!page)throw notFound();
      if(page.draft_revision!==b.expectedRevision)throw conflict('این صفحه از زمان باز شدن شما تغییر کرده است؛ نسخه جدید را بارگذاری و بررسی کنید.');
      if(new Set(b.sections.map(s=>s.id)).size!==b.sections.length)throw badRequest('بخش تکراری مجاز نیست.');
      const before=await readDraft(client,id);
      for(const [position,s] of b.sections.entries()) {
        const c=await one<{id:string;field_schema:FieldSchema;variants:string[]}>(client,'SELECT id,field_schema,variants FROM cms_components WHERE code=$1 AND active',[s.component_code]);if(!c)throw badRequest('نوع بخش در دسترس نیست');
        const existing=await one<{page_id:string;component_id:string}>(client,'SELECT page_id,component_id FROM cms_sections WHERE id=$1',[s.id]);if(existing&&existing.page_id!==id)throw badRequest('بخش به این صفحه تعلق ندارد');if(existing&&existing.component_id!==c.id)throw badRequest('نوع بخش موجود تغییر نمی‌کند');
        const payload=validateSectionPayload(c.field_schema,s.payload);
        if(!(c.variants??['default']).includes(s.variant))throw badRequest('چیدمان بخش معتبر نیست');
        await client.query(`INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position,variant,section_theme,style_overrides,responsive_config)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,payload=EXCLUDED.payload,visible=EXCLUDED.visible,position=EXCLUDED.position,variant=EXCLUDED.variant,section_theme=EXCLUDED.section_theme,style_overrides=EXCLUDED.style_overrides,responsive_config=EXCLUDED.responsive_config,updated_at=now() WHERE (cms_sections.title,cms_sections.payload,cms_sections.visible,cms_sections.position,cms_sections.variant,cms_sections.section_theme,cms_sections.style_overrides,cms_sections.responsive_config) IS DISTINCT FROM (EXCLUDED.title,EXCLUDED.payload,EXCLUDED.visible,EXCLUDED.position,EXCLUDED.variant,EXCLUDED.section_theme,EXCLUDED.style_overrides,EXCLUDED.responsive_config)`,
          [s.id,id,c.id,s.title,JSON.stringify(payload),s.visible,position+1,s.variant,s.section_theme,JSON.stringify(validateStyleOverrides(s.style_overrides)),JSON.stringify(responsiveConfigSchema.parse(s.responsive_config))]);
      }
      await client.query('DELETE FROM cms_sections WHERE page_id=$1 AND NOT(id=ANY($2::uuid[]))',[id,b.sections.map(s=>s.id)]);
      await client.query('UPDATE cms_pages SET title=$2,path=$3,description=$4,updated_at=now() WHERE id=$1',[id,b.title,b.path,b.description]);
      const saved=await readDraft(client,id);await audit(client,user.id,'cms.draft_saved','cms_page',id,{revision:before.draft_revision},{revision:saved.draft_revision},request.ip);return saved;
    });
  });
  app.post('/api/v1/admin/cms/pages/:id/duplicate',async(request,reply)=>{
    const user=await actor(request,'cms:edit');const{id}=z.object({id:z.uuid()}).parse(request.params);const b=z.object({title:z.string().trim().min(2).max(160),path:z.string().regex(/^\/[a-z0-9/_-]{1,120}$/)}).strict().parse(request.body);
    return transaction(pool,async(client)=>{
      if(await one(client,'SELECT id FROM cms_pages WHERE path=$1',[b.path]))throw conflict('مسیر تکراری است');
      const source=await one(client,'SELECT id FROM cms_pages WHERE id=$1 FOR UPDATE',[id]);if(!source)throw notFound();
      const newId=randomUUID();const code=`copy-${newId.slice(0,8)}`;
      await client.query(`INSERT INTO cms_pages(id,code,title,path,description,page_type,status,active) SELECT $2,$3,$4,$5,description,page_type,'draft',true FROM cms_pages WHERE id=$1`,[id,newId,code,b.title,b.path]);
      await client.query(`INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position,variant,preset,section_theme,data_binding,style_overrides,responsive_config)
        SELECT gen_random_uuid(),$2,component_id,title,payload,visible,position,variant,preset,section_theme,data_binding,style_overrides,responsive_config FROM cms_sections WHERE page_id=$1`,[id,newId]);
      await audit(client,user.id,'cms.page_duplicated','cms_page',newId,undefined,{source:id},request.ip);return reply.code(201).send({id:newId,code});
    });
  });
  app.get('/api/v1/admin/cms/pages/:id/versions/:version/preview',async(request)=>{
    await actor(request,'cms:read');const{id,version}=z.object({id:z.uuid(),version:z.coerce.number().int().positive()}).parse(request.params);
    const row=await one<Record<string,unknown>>(pool,'SELECT * FROM cms_page_versions WHERE page_id=$1 AND version=$2',[id,version]);if(!row)throw notFound();const {enrichSections}=await import('./cms-studio.js');return {...row,sections:await enrichSections(pool,row.sections_snapshot as Parameters<typeof enrichSections>[1])};
  });
}
