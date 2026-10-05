import type { PoolClient } from 'pg';

/*
 * On-demand CMS starter content (Req 205, 274, 281-283): About, two Vibe landings and the VIP lead page,
 * plus an INACTIVE editorial announcement. Nothing here runs from a migration — a fresh database starts with
 * an empty CMS and an admin creates this content explicitly through POST /api/v1/admin/cms/bootstrap.
 *
 * Only presentation copy lives here. Business values (prices, stock, instalment terms, shipping thresholds,
 * ratings, customer counts) are never written into CMS content; blocks bind to the canonical domains instead.
 * Every statement is idempotent (ON CONFLICT / NOT EXISTS), so re-running bootstrap never duplicates or resets edits.
 */
const STARTER_SQL: string[] = [
  `INSERT INTO cms_announcements(id, title, messages, mode, style, binding_type, priority, active) VALUES
  ('8a660000-0000-4000-8000-000000000001', 'اعلان بالای هدر کلبه',
   '[{"text":"کالکشن جدید پاییز و زمستان کلبه وینتیج منتشر شد","link":"shop","ctaLabel":"کالکشن جدید","icon":"crown"}]'::jsonb,
   'rotating',
   '{"backgroundColor":"#1B2A4A","textColor":"#F9F6F1","fontFamily":"Vazirmatn","speed":"normal","direction":"rtl","heightPx":40,"icon":"sparkles","dismissible":true,"ctaLabel":"مشاهده کالکشن","ctaTarget":"shop"}'::jsonb,
   'none', 100, false)
ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO cms_pages(id, code, title, path, page_type, status, description, seo, active) VALUES
  ('8a770000-0000-4000-8000-000000000001', 'about', 'درباره کلبه وینتیج', '/about', 'about', 'draft',
   'داستان شکل‌گیری کلبه وینتیج، فلسفه طراحی، اصالت پارچه و شبکه تأمین‌کنندگان منتخب',
   '{"title":"درباره ما | کلبه وینتیج","description":"آشنایی با داستان برند کلبه وینتیج، ارزش‌ها و استاندارد کیفیت پوشاک"}'::jsonb, true),
  ('8a770000-0000-4000-8000-000000000002', 'vibe-old-money', 'لندینگ استایل Old Money', '/vibe/old-money', 'vibe', 'draft',
   'راهنمای کامل و محصولات منتخب استایل Old Money در کلبه وینتیج',
   '{"title":"استایل Old Money | کلبه وینتیج","description":"پالت رنگ کرم و سرمه‌ای، کت‌های پشمی و پیراهن‌های کلاسیک"}'::jsonb, true),
  ('8a770000-0000-4000-8000-000000000003', 'vibe-dark-academia', 'لندینگ استایل Dark Academia', '/vibe/dark-academia', 'vibe', 'draft',
   'گزیده پوشاک پاییزی و زمستانی با زیبایی‌شناسی Dark Academia',
   '{"title":"استایل Dark Academia | کلبه وینتیج","description":"ترنچ‌کت، بلیزر پشمی و شلوارهای پیلی‌دار با تناژ گرم و تیره"}'::jsonb, true),
  ('8a770000-0000-4000-8000-000000000004', 'vip-lead', 'ثبت‌نام زودهنگام کالکشن اختصاصی', '/landing/vip-club', 'lead_generation', 'draft',
   'صفحه جذب سرنخ متصل به CRM برای دسترسی زودهنگام به کالکشن‌های محدود',
   '{"title":"باشگاه مشتریان ویژه | کلبه وینتیج"}'::jsonb, true)
ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO cms_sections(id, page_id, component_id, title, payload, visible, position)
SELECT gen_random_uuid(), p.id, c.id, v.title, v.payload::jsonb, true, v.position
FROM (VALUES
  ('about', 'story_hero', 'هیرو داستان ما', '{"eyebrow":"از ۱۳۹۸","title":"کلبه وینتیج؛ پوشاکی برای سال‌ها","subtitle":"از یک کارگاه کوچک در تهران شروع کردیم تا پارچه خوب، دوخت دقیق و طراحی ماندگار را به کمد لباس شما بیاوریم.","yearFounded":"۱۳۹۸","location":"تهران"}', 1),
  ('about', 'text_section', 'روایت برند', '{"eyebrow":"داستان برند","title":"اصالت، دوخت و ماندگاری","body":"هر محصول کلبه مسیر مشخصی دارد: انتخاب پارچه از بافندگان معتبر، الگوسازی دقیق، دوخت تمیز و کنترل کیفیت سه‌مرحله‌ای.\\nما باور داریم لباس خوب باید سال‌ها بماند؛ نه یک فصل.","alignment":"center"}', 2),
  ('about', 'timeline', 'مسیر کلبه', '{"title":"مسیر کلبه","milestones":"۱۳۹۸|آغاز کارگاه کوچک کلبه در تهران\\n۱۴۰۰|راه‌اندازی فروشگاه آنلاین و ارسال سراسری\\n۱۴۰۲|بازارچه عمده و شبکه تأمین‌کنندگان منتخب\\n۱۴۰۵|استایل‌بیلدر هوشمند و پرو مجازی"}', 3),
  ('about', 'values_grid', 'ارزش‌های ما', '{"title":"ارزش‌های ما","values":"اصالت|پارچه طبیعی، دوخت دقیق و ضمانت اصالت کالا\\nماندگاری|طراحی فراتر از فصل و مد زودگذر\\nشفافیت|قیمت، موجودی و ارسال واقعی و قابل پیگیری"}', 4),
  ('about', 'cta', 'دعوت به خرید', '{"title":"کالکشن کلبه را ببینید","cta":"ورود به فروشگاه","target":"shop"}', 6),
  ('vibe-old-money', 'hero', 'هیرو Old Money', '{"template":"minimal","eyebrow":"Vibe","title":"Old Money · اصالت اشرافی","subtitle":"پالت کرم، سرمه‌ای و شتری با پشم، کشمیر و کتان طبیعی.","ctaLabel":"خرید این استایل","ctaTarget":"shop"}', 1),
  ('vibe-old-money', 'product_grid', 'منتخب Old Money', '{"title":"منتخب Old Money","collectionCode":"old-money-edit","limit":8}', 2),
  ('vibe-dark-academia', 'hero', 'هیرو Dark Academia', '{"template":"minimal","eyebrow":"Vibe","title":"Dark Academia · آکادمیا تیره","subtitle":"قهوه‌ای تیره، زرشکی و چهارخانه پشمی الهام‌گرفته از کتابخانه‌های کلاسیک.","ctaLabel":"خرید این استایل","ctaTarget":"shop"}', 1),
  ('vibe-dark-academia', 'product_grid', 'پالتو و کت زمستانی', '{"title":"پالتو و کت پاییز و زمستان","collectionCode":"winter-coats","limit":8}', 2),
  ('vip-lead', 'hero', 'هیرو باشگاه ویژه', '{"template":"minimal","eyebrow":"دسترسی زودهنگام","title":"اولین نفر از کالکشن‌های محدود باخبر شوید","subtitle":"اعضای باشگاه ویژه کلبه ۲۴ ساعت زودتر به کالکشن‌های جدید دسترسی دارند.","ctaLabel":"","ctaTarget":"shop"}', 1),
  ('vip-lead', 'lead_form', 'فرم عضویت', '{"title":"عضو باشگاه ویژه شوید","subtitle":"شماره همراه خود را ثبت کنید؛ پیش از انتشار عمومی خبرتان می‌کنیم.","campaignSource":"vip-club","ctaLabel":"ثبت‌نام","consentText":"با ارسال فرم، دریافت پیامک اطلاع‌رسانی کلبه را می‌پذیرم.","collectEmail":true,"collectName":true}', 2)
) AS v(page_code, component_code, title, payload, position)
JOIN cms_pages p ON p.code = v.page_code
JOIN cms_components c ON c.code = v.component_code
WHERE NOT EXISTS (SELECT 1 FROM cms_sections s WHERE s.page_id = p.id)`,
  `UPDATE cms_sections s SET position = s.position + 2 FROM cms_pages p, cms_components c
  WHERE p.id = s.page_id AND c.id = s.component_id AND p.code = 'about' AND c.code = 'cta'
    AND NOT EXISTS (SELECT 1 FROM cms_sections x JOIN cms_components xc ON xc.id = x.component_id WHERE x.page_id = p.id AND xc.code = 'gallery')`,
  `UPDATE cms_sections s SET position = s.position + 1 FROM cms_pages p, cms_components c
  WHERE p.id = s.page_id AND c.id = s.component_id AND p.code IN ('vibe-old-money', 'vibe-dark-academia') AND c.code = 'product_grid'
    AND NOT EXISTS (SELECT 1 FROM cms_sections x JOIN cms_components xc ON xc.id = x.component_id WHERE x.page_id = p.id AND xc.code = 'collection_showcase')`,
  `INSERT INTO cms_sections(id, page_id, component_id, title, payload, visible, position)
SELECT gen_random_uuid(), p.id, c.id, v.title, v.payload::jsonb, true,
       (SELECT COALESCE(max(position), 0) FROM cms_sections WHERE page_id = p.id) + v.offs
FROM (VALUES
  ('about', 'gallery', 'گالری کارگاه', '{"title":"از کارگاه تا کمد شما","layout":"masonry","columns":3,"images":"https://images.unsplash.com/photo-1558769132-cb1aea458c5e?w=1200|کارگاه دوخت کلبه|انتخاب پارچه\\nhttps://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=1200|قفسه پوشاک|کالکشن پاییز\\nhttps://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1200|جزئیات دوخت|دوخت دقیق"}', -2),
  ('about', 'video_section', 'ویدیو داستان برند', '{"title":"کلبه در یک دقیقه","caption":"روایت کوتاه ما از انتخاب پارچه تا بسته‌بندی","video":"https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4","poster":"https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1600","aspect":"16/9","controls":true,"muted":true}', -1),
  ('vibe-old-money', 'text_section', 'روایت Old Money', '{"eyebrow":"Editorial","title":"اصالت بی‌صدا","body":"Old Money یعنی لباسی که به چشم نمی‌آید اما فراموش نمی‌شود: پشم مرغوب، رنگ‌های خنثی و دوختی که سال‌ها می‌ماند.","alignment":"center","maxWidth":"narrow"}', -1),
  ('vibe-old-money', 'collection_showcase', 'کالکشن‌های مرتبط', '{"title":"کالکشن‌های مرتبط","subtitle":"گزیده‌هایی که با این وایب هماهنگ‌اند","limit":4}', 1),
  ('vibe-dark-academia', 'text_section', 'روایت Dark Academia', '{"eyebrow":"Editorial","title":"کتابخانه، باران، پشم","body":"تناژ قهوه‌ای و زرشکی، چهارخانه‌های پشمی و لایه‌بندی گرم؛ استایلی برای روزهای کوتاه پاییز.","alignment":"center","maxWidth":"narrow"}', -1),
  ('vibe-dark-academia', 'collection_showcase', 'کالکشن‌های مرتبط', '{"title":"کالکشن‌های مرتبط","limit":4}', 1)
) AS v(page_code, component_code, title, payload, offs)
JOIN cms_pages p ON p.code = v.page_code
JOIN cms_components c ON c.code = v.component_code
WHERE NOT EXISTS (SELECT 1 FROM cms_sections s WHERE s.page_id = p.id AND s.component_id = c.id)`,
];

export const STARTER_PAGE_CODES = ['about', 'vibe-old-money', 'vibe-dark-academia', 'vip-lead'] as const;

/** Runs inside the bootstrap transaction. Returns how many starter pages were newly created. */
export async function seedStarterContent(client: PoolClient): Promise<{ pagesCreated: number }> {
  const before = await client.query('SELECT count(*)::int AS n FROM cms_pages WHERE code = ANY($1::text[])', [STARTER_PAGE_CODES]);
  for (const sql of STARTER_SQL) await client.query(sql);
  // SEO lives in the SEO domain (seo_entries); seed it from the page-level defaults once, never overwriting edits.
  await client.query(`INSERT INTO seo_entries(id, entity_type, entity_key, title, description, canonical_path, robots_index)
    SELECT gen_random_uuid(), 'page', p.code, NULLIF(p.seo->>'title', ''), NULLIF(p.seo->>'description', ''),
           NULLIF(p.seo->>'canonical', ''), COALESCE((p.seo->>'index')::boolean, true)
    FROM cms_pages p WHERE p.code = ANY($1::text[]) AND p.seo <> '{}'::jsonb
    ON CONFLICT (entity_type, entity_key) DO NOTHING`, [STARTER_PAGE_CODES]);
  const after = await client.query('SELECT count(*)::int AS n FROM cms_pages WHERE code = ANY($1::text[])', [STARTER_PAGE_CODES]);
  return { pagesCreated: Number(after.rows[0].n) - Number(before.rows[0].n) };
}
