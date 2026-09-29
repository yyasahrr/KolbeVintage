-- Migration 035 (Agent C range 035-044; formerly 016): Requirements 173-244 (CMS Redesign, Theme Engine, Product Cards, Vibes, Collections, Layout, Assets),
-- 248-283 & 315-324 (Style Builder Intelligence, Compatibility Score, Media Roles, Saved Styles, Reviews, Recommendations),
-- 325-356 (Adaptive Product Type Templates, Announcement Bar Engine, Unified Profile Domain, Supplier Approval Diff, Account Security & Dashboard).

-- 1. Expand cms_components to support full Component Registry & Composable Builder (Req 175-184, 238-240)
ALTER TABLE cms_components DROP CONSTRAINT IF EXISTS cms_components_component_type_check;
ALTER TABLE cms_components ADD CONSTRAINT cms_components_component_type_check CHECK (
  component_type IN (
    'hero', 'video_hero', 'image_hero', 'banner', 'promotion_banner', 'countdown',
    'product_slider', 'product_grid', 'product_carousel', 'product_card',
    'category_section', 'category_card', 'promotional', 'text_image', 'text_section',
    'cta', 'installment_card', 'brand_section', 'brand_strip', 'review_section',
    'recommendation_section', 'newsletter', 'faq', 'blog_section', 'lead_form',
    'story_hero', 'brand_story', 'timeline', 'values_grid', 'gallery', 'video_section',
    'stats_strip', 'spacer', 'divider', 'composable', 'custom'
  )
);

ALTER TABLE cms_components
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'composable')),
  ADD COLUMN IF NOT EXISTS composition jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS presets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '["default"]'::jsonb,
  ADD COLUMN IF NOT EXISTS style_tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Seed canonical Component Registry with schemas, presets & variants (Req 175-182, 188, 209-213, 239-240, 274, 283)
INSERT INTO cms_components(id, code, title, component_type, kind, field_schema, presets, variants, data_source) VALUES
  (gen_random_uuid(), 'hero', 'هیرو اصلی (Hero)', 'hero', 'code',
   '{"props":["headline","eyebrow","description","media","video","poster","cta","secondaryCta","alignment","height","overlay","theme","animation","template","bindingType","bindingId"]}'::jsonb,
   '["Minimal Hero","Editorial Hero","Video Hero","Split Hero","Full-screen Hero","Product Hero","Campaign Hero","Collection Hero","Horizontal Media Hero","Cinematic Hero"]'::jsonb,
   '["split","fullbleed","video","carousel","minimal","mosaic","editorial","cinematic"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'video_hero', 'هیرو ویدیویی (Video Hero)', 'video_hero', 'code',
   '{"props":["video","poster","mobileVideo","mobilePoster","autoplay","muted","loop","overlay","headline","cta"]}'::jsonb,
   '["Video Hero","Cinematic Hero","Full Viewport Hero"]'::jsonb, '["default","cinematic","split"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'image_hero', 'هیرو تصویری (Image Hero)', 'image_hero', 'code',
   '{"props":["headline","eyebrow","description","media","cta","alignment","height","overlay"]}'::jsonb,
   '["Static Image Hero","Editorial Hero","Minimal Hero"]'::jsonb, '["default","editorial","minimal"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'countdown', 'شمارش معکوس جشنواره (Countdown)', 'countdown', 'code',
   '{"props":["title","targetDate","mode","campaignId","background","foreground","radius","layout","showDays","showHours","showMinutes","showSeconds","cta","target"]}'::jsonb,
   '["Minimal","Dark","Floating","Glass","Banner","Compact"]'::jsonb,
   '["banner","minimal","dark","floating","glass","compact"]'::jsonb, 'campaign'),
  (gen_random_uuid(), 'product_grid', 'شبکه محصولات (Product Grid)', 'product_grid', 'code',
   '{"props":["title","subtitle","collectionCode","category","vibe","campaignId","cardVariant","columns","limit"]}'::jsonb,
   '["Editorial Grid","4-Column Classic","Sale Grid","New Arrivals Grid"]'::jsonb,
   '["default","editorial","compact","luxury"]'::jsonb, 'products'),
  (gen_random_uuid(), 'product_carousel', 'کاروسل محصولات (Product Carousel)', 'product_carousel', 'code',
   '{"props":["title","collectionCode","category","vibe","limit","cardVariant"]}'::jsonb,
   '["Editorial Carousel","Best Sellers","Flash Sale Carousel"]'::jsonb,
   '["default","editorial","minimal"]'::jsonb, 'products'),
  (gen_random_uuid(), 'product_card', 'کارت محصول (Product Card)', 'product_card', 'code',
   '{"props":["variant","showInstallment","showRating","showBadges","showSwatches"]}'::jsonb,
   '["Classic","Editorial","Minimal","Image-first","Luxury","Sale","New Arrival","VIP"]'::jsonb,
   '["default","sale","new","premium","editorial","wholesale"]'::jsonb, 'products'),
  (gen_random_uuid(), 'category_card', 'کارت دسته‌بندی (Category Card)', 'category_card', 'code',
   '{"props":["template","showCount","showDescription","columns"]}'::jsonb,
   '["Image Card","Editorial Card","Minimal Card","Glass Card","Overlay Card","Horizontal Card"]'::jsonb,
   '["image","editorial","minimal","glass","overlay","horizontal"]'::jsonb, 'categories'),
  (gen_random_uuid(), 'promotion_banner', 'بنر جشنواره و کمپین (Promotion Banner)', 'promotion_banner', 'code',
   '{"props":["title","subtitle","campaignId","image","cta","target","tone","showCountdown"]}'::jsonb,
   '["Black Friday Banner","Valentine Banner","Seasonal Sale"]'::jsonb,
   '["default","dark","terra","split"]'::jsonb, 'campaign'),
  (gen_random_uuid(), 'installment_card', 'کارت خرید اقساطی (Installment Card)', 'installment_card', 'code',
   '{"props":["provider","installmentsCount","title","subtitle","sampleAmountRial","cta"]}'::jsonb,
   '["SnappPay Card","Digipay Card","Generic Installment Card"]'::jsonb,
   '["snapppay","digipay","generic"]'::jsonb, 'products'),
  (gen_random_uuid(), 'brand_strip', 'نوار برندها و ارزش‌ها (Brand Strip)', 'brand_strip', 'code',
   '{"props":["title","items","variant"]}'::jsonb,
   '["Minimal Strip","Trust Strip","Editorial Partners"]'::jsonb,
   '["default","minimal","marquee"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'review_section', 'بخش دیدگاه و امتیاز مشتریان (Review Section)', 'review_section', 'code',
   '{"props":["title","productId","showPhotos","showSummary","limit"]}'::jsonb,
   '["Product Rating Summary","Customer Stories","Verified Reviews Grid"]'::jsonb,
   '["default","summary","editorial"]'::jsonb, 'reviews'),
  (gen_random_uuid(), 'recommendation_section', 'پیشنهاد هوشمند محصولات (Recommendation Section)', 'recommendation_section', 'code',
   '{"props":["title","strategy","vibe","category","limit"]}'::jsonb,
   '["پیشنهاد برای شما","محصولات مشابه","محبوب‌ترین‌ها","ترند"]'::jsonb,
   '["for_you","similar","popular","trending"]'::jsonb, 'recommendations'),
  (gen_random_uuid(), 'newsletter', 'خبرنامه (Newsletter)', 'newsletter', 'code',
   '{"props":["title","text","cta","tone"]}'::jsonb,
   '["Minimal Newsletter","Editorial Club","Dark Banner"]'::jsonb,
   '["default","minimal","dark"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'text_section', 'بخش متنی و روایت برند (Text Section)', 'text_section', 'code',
   '{"props":["eyebrow","title","body","alignment","maxWidth"]}'::jsonb,
   '["Brand Story","Editorial Quote","Manifesto"]'::jsonb,
   '["default","centered","editorial"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'lead_form', 'فرم جذب سرنخ (Lead Generation Form)', 'lead_form', 'code',
   '{"props":["title","subtitle","campaignSource","ctaLabel","consentText","collectEmail","collectName"]}'::jsonb,
   '["VIP Early Access","Lookbook Download","Campaign Waitlist"]'::jsonb,
   '["default","split","compact"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'story_hero', 'هیرو داستان ما (Story Hero)', 'story_hero', 'code',
   '{"props":["eyebrow","title","subtitle","image","yearFounded","location"]}'::jsonb,
   '["About Hero","Heritage Split"]'::jsonb, '["default","split"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'timeline', 'تایم‌لاین روایت کلبه (Timeline)', 'timeline', 'code',
   '{"props":["title","milestones"]}'::jsonb,
   '["Brand Timeline","Craft Process"]'::jsonb, '["default","vertical"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'values_grid', 'ارزش‌های برند (Values Grid)', 'values_grid', 'code',
   '{"props":["title","values"]}'::jsonb,
   '["3 Pillars","4 Values Grid"]'::jsonb, '["default","minimal"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'stats_strip', 'نوار آمار و افتخارات (Stats Strip)', 'stats_strip', 'code',
   '{"props":["stats","tone"]}'::jsonb,
   '["Impact Numbers","Store Milestones"]'::jsonb, '["default","dark"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'spacer', 'فاصله‌انداز (Spacer)', 'spacer', 'code',
   '{"props":["heightPx","mobileHeightPx"]}'::jsonb,
   '["Small 24px","Medium 48px","Large 80px"]'::jsonb, '["sm","md","lg"]'::jsonb, 'manual'),
  (gen_random_uuid(), 'divider', 'خط جداکننده (Divider)', 'divider', 'code',
   '{"props":["style","ornament","spacing"]}'::jsonb,
   '["Subtle Line","Editorial Diamond","Dashed"]'::jsonb, '["line","ornament","dashed"]'::jsonb, 'manual')
ON CONFLICT (code) DO UPDATE SET
  field_schema = EXCLUDED.field_schema,
  presets = EXCLUDED.presets,
  variants = EXCLUDED.variants,
  data_source = EXCLUDED.data_source;

-- 2. Expand cms_pages and cms_sections for Draft/Publish/Scheduled/Version History/Data Binding (Req 185-187, 214-217, 227, 274, 281-283)
ALTER TABLE cms_pages
  ADD COLUMN IF NOT EXISTS page_type text NOT NULL DEFAULT 'generic' CHECK (page_type IN ('home', 'about', 'landing', 'campaign', 'collection', 'vibe', 'lead_generation', 'blog_index', 'generic')),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'scheduled', 'published', 'archived')),
  ADD COLUMN IF NOT EXISTS draft_sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_end_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES festivals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS theme_code text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS cms_page_versions (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  sections_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  seo_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_summary text,
  changed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, version)
);

ALTER TABLE cms_sections
  ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS preset text,
  ADD COLUMN IF NOT EXISTS section_theme text NOT NULL DEFAULT 'inherit' CHECK (section_theme IN ('inherit', 'light', 'dark', 'campaign')),
  ADD COLUMN IF NOT EXISTS data_binding jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS style_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS responsive_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 3. Product Card Templates & Rule Engine (Req 192-198)
CREATE TABLE IF NOT EXISTS cms_product_card_templates (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  variant text NOT NULL DEFAULT 'classic',
  blocks jsonb NOT NULL DEFAULT '["image","badge","brand","name","original_price","discount_price","installment","rating","cta"]'::jsonb,
  styles jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_product_card_templates(id, code, name, variant, blocks, styles, quality_report, is_system) VALUES
  (gen_random_uuid(), 'kolbe-classic', 'Kolbe Classic · کلاسیک کلبه', 'classic',
   '["image","badge","brand","name","discount_price","installment","rating","cta"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"18px","badgeTone":"surface","accentColor":"#1B2A4A","showSwatches":true}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-editorial', 'Kolbe Editorial · ادیتوریال', 'editorial',
   '["image","badge","brand","name","discount_price","cta"]'::jsonb,
   '{"aspectRatio":"4/5","radius":"22px","badgeTone":"glass","accentColor":"#C1613B","serifTitle":true}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-minimal', 'Kolbe Minimal · مینیمال', 'minimal',
   '["image","name","discount_price"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"14px","borderless":true,"accentColor":"#0E1527"}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-sale', 'Kolbe Sale · حراج ویژه', 'sale',
   '["image","badge","brand","name","original_price","discount_price","installment","cta"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"18px","badgeTone":"danger","accentColor":"#B42318","highlightDiscount":true}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-flash-sale', 'Kolbe Flash Sale · فروش فوری', 'flash-sale',
   '["image","badge","name","original_price","discount_price","countdown","cta"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"18px","badgeTone":"terra","accentColor":"#C1613B","highlightDiscount":true}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-new-arrival', 'Kolbe New Arrival · کالکشن جدید', 'new',
   '["image","badge","brand","name","discount_price","rating","cta"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"20px","badgeTone":"emerald","accentColor":"#2E5A44"}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-premium', 'Kolbe Premium · لوکس و دست‌دوز', 'premium',
   '["image","badge","brand","name","discount_price","installment","cta"]'::jsonb,
   '{"aspectRatio":"4/5","radius":"22px","badgeTone":"gold","accentColor":"#8A6A3E","luxuryBorder":true}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-installment', 'Kolbe Installment · خرید چهارقسطه', 'installment',
   '["image","badge","brand","name","discount_price","installment","cta"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"18px","badgeTone":"navy","accentColor":"#1B2A4A","prominentInstallment":true}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true),
  (gen_random_uuid(), 'kolbe-dark', 'Kolbe Dark · تیره اشرافی', 'dark',
   '["image","badge","brand","name","original_price","discount_price","cta"]'::jsonb,
   '{"aspectRatio":"3/4","radius":"18px","darkSurface":true,"accentColor":"#E8D9C3"}'::jsonb,
   '{"hierarchy":true,"spacing":true,"typography":true,"contrast":true,"mobile":true,"accessibility":true,"rtl":true,"passed":true}'::jsonb, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS cms_product_card_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_code text NOT NULL REFERENCES cms_product_card_templates(code) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_product_card_rules(id, name, priority, conditions, template_code, active) VALUES
  ('8a110000-0000-4000-8000-000000000001', 'محصولات با تخفیف بالای ۵۰٪ (Major Sale)', 1, '{"minDiscountPercent":50}'::jsonb, 'kolbe-sale', true),
  ('8a110000-0000-4000-8000-000000000002', 'محصولات جشنواره فعال (Campaign)', 2, '{"inActiveCampaign":true}'::jsonb, 'kolbe-flash-sale', true),
  ('8a110000-0000-4000-8000-000000000003', 'محصولات جدید (New Arrival)', 3, '{"isNew":true}'::jsonb, 'kolbe-new-arrival', true),
  ('8a110000-0000-4000-8000-000000000004', 'محصولات دارای خرید اقساطی (Installment)', 4, '{"installmentEnabled":true}'::jsonb, 'kolbe-installment', true),
  ('8a110000-0000-4000-8000-000000000005', 'کارت پیش‌فرض کلبه (Default)', 5, '{}'::jsonb, 'kolbe-classic', true)
ON CONFLICT (id) DO NOTHING;

-- 4. CMS Categories & Vibes & Dynamic/Manual Collections (Req 199-208)
CREATE TABLE IF NOT EXISTS cms_categories (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  image_url text,
  cover_url text,
  icon text,
  card_template text NOT NULL DEFAULT 'editorial' CHECK (card_template IN ('image', 'editorial', 'minimal', 'glass', 'overlay', 'horizontal')),
  card_style jsonb NOT NULL DEFAULT '{}'::jsonb,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  parent_id uuid REFERENCES cms_categories(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_categories(id, name, slug, description, card_template, position, seo) VALUES
  ('8a220000-0000-4000-8000-000000000001', 'کت و پالتو', 'coats', 'ترنچ‌کت، بلیزر پشمی و پالتوهای دست‌دوز کلاسیک', 'editorial', 1, '{"title":"خرید کت و پالتو کلاسیک | کلبه وینتیج"}'::jsonb),
  ('8a220000-0000-4000-8000-000000000002', 'پیراهن و شومیز', 'shirts', 'پیراهن‌های کتان، آکسفورد و ابریشمی با برش ماندگار', 'image', 2, '{"title":"پیراهن و شومیز | کلبه وینتیج"}'::jsonb),
  ('8a220000-0000-4000-8000-000000000003', 'شلوار', 'trousers', 'شلوارهای پارچه‌ای پیلی‌دار، فاستونی و کتان', 'minimal', 3, '{"title":"شلوار کلاسیک و مدرن | کلبه وینتیج"}'::jsonb),
  ('8a220000-0000-4000-8000-000000000004', 'کفش و بوت', 'shoes', 'لوفر چرمی، چلسی بوت و کفش‌های دست‌دوز', 'glass', 4, '{"title":"کفش و بوت چرمی | کلبه وینتیج"}'::jsonb),
  ('8a220000-0000-4000-8000-000000000005', 'بافت و هودی', 'knitwear', 'پلیور پشم مرینوس، ژاکت بافت و هودی سنگین', 'overlay', 5, '{"title":"بافت و پلیور | کلبه وینتیج"}'::jsonb),
  ('8a220000-0000-4000-8000-000000000006', 'اکسسوری', 'accessories', 'کمربند چرم طبیعی، شال پشمی و کیف دستی', 'horizontal', 6, '{"title":"اکسسوری کلاسیک | کلبه وینتیج"}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS cms_vibes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  cover_url text,
  palette jsonb NOT NULL DEFAULT '{}'::jsonb,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_vibes(id, name, slug, description, palette, position, seo) VALUES
  ('8a330000-0000-4000-8000-000000000001', 'Old Money · اصالت اشرافی', 'old-money', 'پالت کرم، سرمه‌ای و شتری با پارچه‌های پشم، کشمیر و کتان طبیعی.', '{"primary":"#1B2A4A","accent":"#8A6A3E","background":"#F7F3EB"}'::jsonb, 1, '{"title":"استایل Old Money | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000002', 'Dark Academia · آکادمیا تیره', 'dark-academia', 'ترکیب قهوه‌ای تیره، زرشکی و چهارخانه پشمی الهام‌گرفته از کتابخانه‌های کلاسیک.', '{"primary":"#2A1E17","accent":"#7A3E2E","background":"#F3EDE4"}'::jsonb, 2, '{"title":"استایل Dark Academia | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000003', 'Quiet Luxury · لوکس آرام', 'quiet-luxury', 'برش‌های بی‌نقص و مینیمال بدون لوگوهای پرزرق‌وبرق با تمرکز بر کیفیت دوخت.', '{"primary":"#1C1E21","accent":"#9C8265","background":"#F9F7F3"}'::jsonb, 3, '{"title":"استایل Quiet Luxury | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000004', 'Vintage · وینتیج اصیل', 'vintage', 'بازآفرینی سیلوئت‌های ماندگار دهه‌های ۵۰ تا ۸۰ میلادی با پارچه‌های منتخب.', '{"primary":"#3B281E","accent":"#C1613B","background":"#F8F2E8"}'::jsonb, 4, '{"title":"استایل Vintage | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000005', 'Minimal · مینیمال مدرن', 'minimal', 'خطوط تمیز، رنگ‌های خنثی و کپسول کمد لباس روزمره.', '{"primary":"#111827","accent":"#4B5563","background":"#FAFAFA"}'::jsonb, 5, '{"title":"استایل Minimal | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000006', 'Streetwear · استریت‌ویر', 'streetwear', 'فرم‌های آزاد، لایه‌بندی شهری و راحتی روزمره.', '{"primary":"#0F172A","accent":"#EA580C","background":"#F5F5F4"}'::jsonb, 6, '{"title":"استایل Streetwear | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000007', 'Workwear · ورک‌ویر کلاسیک', 'workwear', 'جنس‌های مقاوم، جیب‌های کاربردی و کت‌های کارگری بازطراحی‌شده.', '{"primary":"#27372B","accent":"#A16207","background":"#F6F4EE"}'::jsonb, 7, '{"title":"استایل Workwear | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000008', 'Y2K · نئوکلاسیک ۲۰۰۰', 'y2k', 'جزئیات جسورانه و کنتراست‌های دهه ۲۰۰۰ میلادی.', '{"primary":"#1E1B4B","accent":"#DB2777","background":"#FDF4FF"}'::jsonb, 8, '{"title":"استایل Y2K | کلبه وینتیج"}'::jsonb),
  ('8a330000-0000-4000-8000-000000000009', 'Classic · رسمی و کلاسیک', 'classic', 'تناسب استاندارد و رسمی برای جلسات و موقعیت‌های تشریفاتی.', '{"primary":"#1B2A4A","accent":"#B45309","background":"#F9F6F1"}'::jsonb, 9, '{"title":"استایل Classic | کلبه وینتیج"}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS cms_collections (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'dynamic' CHECK (mode IN ('dynamic', 'manual')),
  query_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_ids uuid[] NOT NULL DEFAULT '{}',
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_collections(id, code, title, description, mode, query_rules) VALUES
  ('8a440000-0000-4000-8000-000000000001', 'new-arrivals', 'تازه‌رسیده‌های کلبه', 'جدیدترین محصولات موجود در انبار', 'dynamic', '{"inStockOnly":true,"sortBy":"newest","limit":8}'::jsonb),
  ('8a440000-0000-4000-8000-000000000002', 'old-money-edit', 'گزیده Old Money', 'محصولات دارای وایب Old Money و موجود در انبار', 'dynamic', '{"vibe":"old-money","inStockOnly":true,"limit":8}'::jsonb),
  ('8a440000-0000-4000-8000-000000000003', 'installment-picks', 'منتخب خرید چهارقسطه', 'محصولات دارای شرایط پرداخت ۴ قسط بدون بهره', 'dynamic', '{"installmentEnabled":true,"inStockOnly":true,"limit":8}'::jsonb),
  ('8a440000-0000-4000-8000-000000000004', 'winter-coats', 'پالتو و کت زمستانی', 'کت و پالتوهای مناسب پاییز و زمستان', 'dynamic', '{"season":"winter","inStockOnly":true,"limit":8}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- 5. Site Theme Engine & Design Tokens & Presets (Req 218-228)
ALTER TABLE color_palettes
  ADD COLUMN IF NOT EXISTS design_tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_preset boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES festivals(id) ON DELETE SET NULL;

INSERT INTO color_palettes(id, code, name, occasion, colors, design_tokens, is_preset) VALUES
  ('8a550000-0000-4000-8000-000000000001', 'kolbe-default', 'پالت اصلی کلبه (Kolbe Default)', 'default',
   '{"primary":"#1B2A4A","secondary":"#C1613B","accent":"#C1613B","background":"#F9F6F1","surface":"#FFFFFF","text":"#0E1527"}'::jsonb,
   '{"background":"#F9F6F1","surface":"#FFFFFF","surfaceSecondary":"#F1ECE1","textPrimary":"#0E1527","textSecondary":"#5B616E","primary":"#1B2A4A","secondary":"#C1613B","accent":"#C1613B","border":"#E4DDD0","success":"#2E6B47","warning":"#B7791F","danger":"#B42318","radius":"16px","shadow":"soft","font":"Vazirmatn","spacing":"comfortable"}'::jsonb, true),
  ('8a550000-0000-4000-8000-000000000002', 'valentine', 'تم ولنتاین (Valentine)', 'valentine',
   '{"primary":"#5C162E","secondary":"#C93B61","accent":"#C93B61","background":"#FFF7F9","surface":"#FFFFFF","text":"#2D0C18"}'::jsonb,
   '{"background":"#FFF7F9","surface":"#FFFFFF","surfaceSecondary":"#FCE8EE","textPrimary":"#2D0C18","textSecondary":"#7A4458","primary":"#5C162E","secondary":"#C93B61","accent":"#C93B61","border":"#F3CEDB","success":"#2E6B47","warning":"#B7791F","danger":"#B42318","radius":"20px","shadow":"rose","font":"Vazirmatn","spacing":"comfortable"}'::jsonb, true),
  ('8a550000-0000-4000-8000-000000000003', 'black-friday', 'تم بلک فرایدی (Black Friday)', 'black-friday',
   '{"primary":"#0B0F17","secondary":"#E05A2B","accent":"#E05A2B","background":"#111622","surface":"#1A2234","text":"#F9F6F1"}'::jsonb,
   '{"background":"#111622","surface":"#1A2234","surfaceSecondary":"#232E45","textPrimary":"#F9F6F1","textSecondary":"#A8B3C7","primary":"#E8D9C3","secondary":"#E05A2B","accent":"#E05A2B","border":"#2E3A52","success":"#34D399","warning":"#FBBF24","danger":"#F87171","radius":"16px","shadow":"high-contrast","font":"Vazirmatn","spacing":"compact"}'::jsonb, true),
  ('8a550000-0000-4000-8000-000000000004', 'nowruz', 'تم نوروز باستانی (Nowruz)', 'nowruz',
   '{"primary":"#1D4D3E","secondary":"#C48F36","accent":"#2E7D62","background":"#F7FAF6","surface":"#FFFFFF","text":"#102820"}'::jsonb,
   '{"background":"#F7FAF6","surface":"#FFFFFF","surfaceSecondary":"#E8F2EA","textPrimary":"#102820","textSecondary":"#4A665B","primary":"#1D4D3E","secondary":"#C48F36","accent":"#2E7D62","border":"#D1E3D5","success":"#2E6B47","warning":"#B7791F","danger":"#B42318","radius":"18px","shadow":"soft","font":"Vazirmatn","spacing":"comfortable"}'::jsonb, true),
  ('8a550000-0000-4000-8000-000000000005', 'winter', 'تم زمستانی (Winter)', 'winter',
   '{"primary":"#1B2A4A","secondary":"#6B7F9E","accent":"#8C4A32","background":"#F4F6F9","surface":"#FFFFFF","text":"#0E1726"}'::jsonb,
   '{"background":"#F4F6F9","surface":"#FFFFFF","surfaceSecondary":"#E7ECF2","textPrimary":"#0E1726","textSecondary":"#526075","primary":"#1B2A4A","secondary":"#6B7F9E","accent":"#8C4A32","border":"#D6DEE8","success":"#2E6B47","warning":"#B7791F","danger":"#B42318","radius":"16px","shadow":"crisp","font":"Vazirmatn","spacing":"comfortable"}'::jsonb, true),
  ('8a550000-0000-4000-8000-000000000006', 'summer', 'تم تابستانی (Summer)', 'summer',
   '{"primary":"#2B3D34","secondary":"#D48C46","accent":"#D48C46","background":"#FDFBF6","surface":"#FFFFFF","text":"#1D2621"}'::jsonb,
   '{"background":"#FDFBF6","surface":"#FFFFFF","surfaceSecondary":"#F6EFE0","textPrimary":"#1D2621","textSecondary":"#636E67","primary":"#2B3D34","secondary":"#D48C46","accent":"#D48C46","border":"#EAE0CC","success":"#2E6B47","warning":"#B7791F","danger":"#B42318","radius":"18px","shadow":"warm","font":"Vazirmatn","spacing":"airy"}'::jsonb, true)
ON CONFLICT (code) DO UPDATE SET
  design_tokens = EXCLUDED.design_tokens,
  is_preset = EXCLUDED.is_preset;

-- 6. CMS Asset Library, Media Usage, Analytics Events, Leads, Announcements & Global Layout (Req 229-236, 275-283, 327-332)
CREATE TABLE IF NOT EXISTS cms_assets (
  id uuid PRIMARY KEY,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  title text NOT NULL,
  asset_type text NOT NULL CHECK (asset_type IN ('image', 'video', 'icon', 'document')),
  url text NOT NULL,
  folder text NOT NULL DEFAULT 'general',
  tags text[] NOT NULL DEFAULT '{}',
  alt_text text NOT NULL DEFAULT '',
  mime_type text,
  size_bytes integer NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cms_asset_usages (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES cms_assets(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cms_asset_usages_asset_idx ON cms_asset_usages(asset_id);

CREATE TABLE IF NOT EXISTS cms_analytics_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('component.view', 'banner.click', 'product_card.click', 'campaign.click', 'cta.click')),
  page_code text,
  section_id uuid,
  component_code text,
  target_id text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cms_announcements (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  mode text NOT NULL DEFAULT 'static' CHECK (mode IN ('static', 'marquee', 'ticker', 'slider', 'rotating')),
  style jsonb NOT NULL DEFAULT '{}'::jsonb,
  binding_type text NOT NULL DEFAULT 'none' CHECK (binding_type IN ('none', 'campaign', 'promotion', 'coupon', 'collection', 'landing_page')),
  binding_id text,
  priority integer NOT NULL DEFAULT 10,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cms_leads (
  id uuid PRIMARY KEY,
  page_code text NOT NULL,
  campaign_source text,
  full_name text,
  phone text,
  email text,
  consent boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  crm_contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed Global Layout (Header, Mega Menu, Footer, Account Appearance) in site_settings (Req 275-280, 323, 354)
INSERT INTO site_settings(key, value) VALUES
  ('global_header', '{
    "variant": "default",
    "logoText": "KOLBE",
    "logoSubtext": "VINTAGE",
    "showSearch": true,
    "showWishlist": true,
    "showCart": true,
    "showAccount": true,
    "showThemeToggle": true,
    "ctaLabel": "بازارچه عمده",
    "ctaTarget": "vip",
    "menus": [
      {"id": "home", "label": "خانه", "target": "home", "order": 1, "active": true},
      {"id": "shop", "label": "فروشگاه", "target": "shop", "order": 2, "active": true, "hasMegaMenu": true},
      {"id": "about", "label": "درباره ما", "target": "about", "order": 3, "active": true},
      {"id": "tryon", "label": "پرو مجازی و استایل‌بیلدر", "target": "tryon", "order": 4, "active": true},
      {"id": "journal", "label": "مجله", "target": "journal", "order": 5, "active": true},
      {"id": "vip", "label": "بازارچه عمده", "target": "vip", "order": 6, "active": true, "vip": true}
    ],
    "megaMenu": [
      {
        "id": "men",
        "title": "مردانه",
        "items": [
          {"label": "کت و پالتو مردانه", "category": "کت و پالتو", "gender": "men"},
          {"label": "پیراهن کلاسیک", "category": "پیراهن", "gender": "men"},
          {"label": "شلوار پارچه‌ای و کتان", "category": "شلوار", "gender": "men"},
          {"label": "کفش چرمی دست‌دوز", "category": "کفش", "gender": "men"}
        ],
        "featuredVibe": "old-money",
        "featuredCollection": "new-arrivals",
        "promoTitle": "گزیده Old Money مردانه"
      },
      {
        "id": "women",
        "title": "زنانه",
        "items": [
          {"label": "ترنچ‌کت و مانتو پشمی", "category": "کت و پالتو", "gender": "women"},
          {"label": "شومیز و پیراهن", "category": "پیراهن", "gender": "women"},
          {"label": "شلوار پیلی‌دار", "category": "شلوار", "gender": "women"},
          {"label": "اکسسوری و کیف", "category": "اکسسوری", "gender": "women"}
        ],
        "featuredVibe": "quiet-luxury",
        "featuredCollection": "winter-coats",
        "promoTitle": "کالکشن Quiet Luxury"
      }
    ]
  }'::jsonb),
  ('global_footer', '{
    "brandTitle": "KOLBE VINTAGE",
    "brandSubtitle": "کلبه، پلی میان اصالت و تجارت مدرن",
    "brandDescription": "پوشاک کلاسیک و مدرن از تأمین‌کنندگان منتخب؛ با ضمانت اصالت، برگشت آسان و ارسال به سراسر کشور.",
    "columns": [
      {
        "title": "خرید و استایل",
        "links": [
          {"label": "همه محصولات", "target": "shop"},
          {"label": "پرو مجازی و ساخت استایل", "target": "tryon"},
          {"label": "درباره کلبه وینتیج", "target": "about"},
          {"label": "مجله کلبه", "target": "journal"}
        ]
      },
      {
        "title": "همکاری و عمده‌فروشی",
        "links": [
          {"label": "بازارچه عمده VIP", "target": "vip"},
          {"label": "ثبت‌نام تأمین‌کنندگان", "target": "supplier"}
        ]
      }
    ],
    "contact": {
      "phone": "۰۲۱-۸۸۰۰۰۰۰۰",
      "address": "تهران، خیابان فرشته، پلاک ۴۲، خانه کلبه وینتیج",
      "email": "hello@kolbe.ir"
    },
    "social": [
      {"platform": "instagram", "label": "اینستاگرام", "url": "https://instagram.com/kolbevintage"},
      {"platform": "telegram", "label": "تلگرام", "url": "https://t.me/kolbevintage"}
    ],
    "trustBadges": ["ضمانت اصالت ۱۰۰٪", "۷ روز ضمانت بازگشت", "پرداخت امن و چهارقسطی"],
    "newsletterEnabled": true,
    "copyright": "© ۱۴۰۵ کلبه وینتیج — تمامی حقوق محفوظ است."
  }'::jsonb),
  ('account_appearance', '{
    "welcomeBanner": {
      "eyebrow": "باشگاه مشتریان کلبه",
      "title": "به خانه استایل شخصی خود خوش آمدید",
      "subtitle": "از همین پنل سفارش‌های فعال، استایل‌های ذخیره‌شده، کوپن‌های اختصاصی و فاکتورهای رسمی خود را مدیریت کنید.",
      "tone": "navy"
    },
    "promoCard": {
      "enabled": true,
      "title": "ارسال رایگان و خرید ۴ قسطه فعال است",
      "subtitle": "بدون کارمزد با اسنپ‌پی و دیجی‌پی یا استفاده از کوپن‌های کیف پول تخفیف شما",
      "ctaLabel": "مشاهده پیشنهادها",
      "ctaTarget": "shop"
    },
    "recommendationHeading": "پیشنهاد هوشمند کلبه برای استایل شما",
    "helpCards": [
      {"title": "نیاز به راهنمای سایز دارید؟", "desc": "مشاوران استایل کلبه در بخش پشتیبانی آماده راهنمایی هستند.", "action": "support"},
      {"title": "همکاری و خرید عمده", "desc": "با ارتقای آنی به پلن عمده، به قیمت‌های سری و بازارچه دسترسی پیدا کنید.", "action": "membership"}
    ]
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- About / Vibe / Lead starter pages are NOT seeded here: fresh databases start with an empty CMS.
-- They are created on demand by POST /api/v1/admin/cms/bootstrap (backend/src/cms-starter.ts).

-- 7. Product Types & Adaptive Specification Templates (Req 4-9, 122-128, 325-326)
CREATE TABLE IF NOT EXISTS product_types (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sizes jsonb NOT NULL DEFAULT '[]'::jsonb,
  spec_template jsonb NOT NULL DEFAULT '[]'::jsonb,
  size_guide_template jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO product_types(id, code, name, description, sizes, spec_template, size_guide_template, position) VALUES
  ('8a880000-0000-4000-8000-000000000001', 'coat', 'کاپشن، کت و پالتو', 'انواع ترنچ‌کت، بلیزر، پالتو پشمی و کاپشن',
   '[{"code":"S","label":"S","position":1,"active":true},{"code":"M","label":"M","position":2,"active":true},{"code":"L","label":"L","position":3,"active":true},{"code":"XL","label":"XL","position":4,"active":true},{"code":"2XL","label":"2XL","position":5,"active":true}]'::jsonb,
   '[
     {"code":"material","label":"جنس پارچه رویه","group":"مشخصات فنی","fieldType":"select","options":["پشم خالص","ترکیب پشم و کشمیر","گاباردین پنبه","چرم طبیعی","جیر","کتان سنگین"],"required":true,"filterable":true},
     {"code":"lining","label":"جنس آستر","group":"مشخصات فنی","fieldType":"select","options":["ویسکوز ابریشمی","ساتن","پشمی چهارخانه","بدون آستر"],"required":false,"filterable":true},
     {"code":"fit","label":"فرم تن‌خور (Fit)","group":"فرم و برش","fieldType":"select","options":["Regular Fit","Relaxed / Oversized","Tailored / Slim"],"required":true,"filterable":true},
     {"code":"waterproof","label":"مقاوم در برابر آب (ضد آب)","group":"ویژگی‌های عملکردی","fieldType":"boolean","options":[],"required":false,"filterable":true},
     {"code":"weight_grams","label":"وزن تقریبی (گرم)","group":"مشخصات فنی","fieldType":"number","unit":"گرم","options":[],"required":false,"filterable":false},
     {"code":"care","label":"راهنمای شست‌وشو و نگهداری","group":"نگهداری","fieldType":"text","options":[],"required":false,"filterable":false}
   ]'::jsonb,
   '{"columns":["سایز","عرض شانه (cm)","دور سینه (cm)","قد لباس (cm)","قد آستین (cm)"],"rows":[["S","44","104","74","62"],["M","46","108","76","63"],["L","48","114","78","64"],["XL","50","120","80","65"]]}'::jsonb, 1),
  ('8a880000-0000-4000-8000-000000000002', 'shirt', 'پیراهن و شومیز', 'پیراهن‌های مردانه و شومیزهای زنانه کلاسیک و کژوال',
   '[{"code":"XS","label":"XS","position":1,"active":true},{"code":"S","label":"S","position":2,"active":true},{"code":"M","label":"M","position":3,"active":true},{"code":"L","label":"L","position":4,"active":true},{"code":"XL","label":"XL","position":5,"active":true},{"code":"2XL","label":"2XL","position":6,"active":true}]'::jsonb,
   '[
     {"code":"material","label":"جنس پارچه","group":"مشخصات فنی","fieldType":"select","options":["کتان ۱۰۰٪","پنبه آکسفورد","پوپلین پنبه","ابریشم طبیعی","لینن"],"required":true,"filterable":true},
     {"code":"fit","label":"فرم تن‌خور","group":"فرم و برش","fieldType":"select","options":["Regular Fit","Relaxed Fit","Slim Fit"],"required":true,"filterable":true},
     {"code":"collar","label":"نوع یقه","group":"جزئیات طراحی","fieldType":"select","options":["کلاسیک","دیپلمات","دکمه‌دار (Button-down)","کوبایی"],"required":false,"filterable":true},
     {"code":"pattern","label":"طرح پارچه","group":"جزئیات طراحی","fieldType":"select","options":["ساده (Solid)","راه‌راه (Striped)","چهارخانه"],"required":false,"filterable":true}
   ]'::jsonb,
   '{"columns":["سایز","دور یقه (cm)","دور سینه (cm)","قد پیراهن (cm)"],"rows":[["S","38","102","73"],["M","40","106","75"],["L","42","112","77"],["XL","44","118","79"]]}'::jsonb, 2),
  ('8a880000-0000-4000-8000-000000000003', 'trousers', 'شلوار', 'شلوارهای پارچه‌ای پیلی‌دار، کتان و جین',
   '[{"code":"30","label":"30","position":1,"active":true},{"code":"32","label":"32","position":2,"active":true},{"code":"34","label":"34","position":3,"active":true},{"code":"36","label":"36","position":4,"active":true},{"code":"38","label":"38","position":5,"active":true},{"code":"40","label":"40","position":6,"active":true}]'::jsonb,
   '[
     {"code":"material","label":"جنس پارچه","group":"مشخصات فنی","fieldType":"select","options":["پشم فاستونی","کتان پنبه","گاباردین","لینن","دنیم سنگین"],"required":true,"filterable":true},
     {"code":"fit","label":"فرم شلوار","group":"فرم و برش","fieldType":"select","options":["راسته کلاسیک (Straight)","گشاد پیلی‌دار (Wide Pleated)","مخروطی (Tapered)"],"required":true,"filterable":true},
     {"code":"rise","label":"بلندی فاق","group":"فرم و برش","fieldType":"select","options":["فاق بلند (High Rise)","فاق متوسط (Mid Rise)"],"required":false,"filterable":true}
   ]'::jsonb,
   '{"columns":["سایز","دور کمر (cm)","دور باسن (cm)","قد شلوار (cm)"],"rows":[["30","78","98","104"],["32","82","102","105"],["34","86","106","106"],["36","91","111","107"]]}'::jsonb, 3),
  ('8a880000-0000-4000-8000-000000000004', 'shoes', 'کفش و بوت', 'کفش‌های چرمی، لوفر، دربی و چلسی بوت',
   '[{"code":"38","label":"38","position":1,"active":true},{"code":"39","label":"39","position":2,"active":true},{"code":"40","label":"40","position":3,"active":true},{"code":"41","label":"41","position":4,"active":true},{"code":"42","label":"42","position":5,"active":true},{"code":"43","label":"43","position":6,"active":true},{"code":"44","label":"44","position":7,"active":true},{"code":"45","label":"45","position":8,"active":true}]'::jsonb,
   '[
     {"code":"upper_material","label":"جنس رویه","group":"مشخصات فنی","fieldType":"select","options":["چرم طبیعی گوساله","جیر طبیعی","چرم الگانت"],"required":true,"filterable":true},
     {"code":"sole_material","label":"جنس زیره","group":"مشخصات فنی","fieldType":"select","options":["چرم دست‌دوز (Goodyear Welt)","رابر طبیعی","نئولیت"],"required":true,"filterable":true},
     {"code":"closure","label":"نحوه بستن","group":"طراحی","fieldType":"select","options":["بدون بند (Loafer)","بنددار (Derby/Oxford)","کش‌دار (Chelsea)"],"required":false,"filterable":true}
   ]'::jsonb,
   '{"columns":["سایز اروپا","طول پا (cm)"],"rows":[["40","25.5"],["41","26.2"],["42","27.0"],["43","27.7"],["44","28.5"]]}'::jsonb, 4),
  ('8a880000-0000-4000-8000-000000000005', 'knitwear', 'بافت، پلیور و هودی', 'پلیورهای پشمی، ژاکت بافت و هودی',
   '[{"code":"S","label":"S","position":1,"active":true},{"code":"M","label":"M","position":2,"active":true},{"code":"L","label":"L","position":3,"active":true},{"code":"XL","label":"XL","position":4,"active":true},{"code":"2XL","label":"2XL","position":5,"active":true}]'::jsonb,
   '[
     {"code":"material","label":"جنس بافت","group":"مشخصات فنی","fieldType":"select","options":["پشم مرینوس","کشمیر","پنبه سنگین دورس","ترکیب پشم و آلپاکا"],"required":true,"filterable":true},
     {"code":"neckline","label":"نوع یقه","group":"طراحی","fieldType":"select","options":["یقه گرد","یقه هفت","یقه اسکی","کلاه‌دار"],"required":false,"filterable":true}
   ]'::jsonb,
   '{"columns":["سایز","عرض سینه (cm)","قد لباس (cm)"],"rows":[["S","52","66"],["M","55","68"],["L","58","70"],["XL","61","72"]]}'::jsonb, 5),
  ('8a880000-0000-4000-8000-000000000006', 'accessory', 'اکسسوری، کیف و کمربند', 'کیف چرمی، کمربند، شال و کلاه',
   '[{"code":"FREE","label":"FREE","position":1,"active":true}]'::jsonb,
   '[
     {"code":"material","label":"جنس","group":"مشخصات فنی","fieldType":"select","options":["چرم طبیعی","پشم خالص","ابریشم","فلز برنج"],"required":true,"filterable":true},
     {"code":"dimensions","label":"ابعاد","group":"مشخصات فنی","fieldType":"text","options":[],"required":false,"filterable":false}
   ]'::jsonb,
   '{}'::jsonb, 6)
ON CONFLICT (code) DO NOTHING;

-- Extend products table with taxonomy & specification columns (Req 203-204, 245-247, 325-326)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_type_code text,
  ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'unisex',
  ADD COLUMN IF NOT EXISTS seasons text[] NOT NULL DEFAULT '{autumn,winter}',
  ADD COLUMN IF NOT EXISTS vibes text[] NOT NULL DEFAULT '{old-money,classic}',
  ADD COLUMN IF NOT EXISTS specifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS installment_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS installment_providers text[] NOT NULL DEFAULT '{snapppay,digipay}',
  ADD COLUMN IF NOT EXISTS discount_percent integer NOT NULL DEFAULT 0;

-- Product Media with explicit roles & automation pipeline state (Req 315-317)
CREATE TABLE IF NOT EXISTS product_media (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('hero', 'gallery', 'flat_lay', 'on_model', 'detail', 'size_guide', 'video')),
  url text NOT NULL,
  cutout_url text,
  mime_type text,
  alt_text text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  pipeline_status text NOT NULL DEFAULT 'ready' CHECK (pipeline_status IN ('uploaded', 'processing', 'ready', 'failed')),
  pipeline_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_media_product_role_idx ON product_media(product_id, role, position);

-- 8. Style Builder Intelligence Engine, Compatibility Matrix, Saved Styles & Reviews (Req 248-269, 315-318, 348-349)
CREATE TABLE IF NOT EXISTS product_style_features (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  feature_version text NOT NULL DEFAULT 'v1',
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text NOT NULL DEFAULT 'kolbe-hybrid-v1',
  source text NOT NULL DEFAULT 'hybrid' CHECK (source IN ('deterministic', 'vision', 'hybrid', 'manual')),
  confidence numeric(4,3) NOT NULL DEFAULT 0.920,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS style_category_matrix (
  id uuid PRIMARY KEY,
  category_a text NOT NULL,
  category_b text NOT NULL,
  compatible boolean NOT NULL DEFAULT true,
  score_weight integer NOT NULL DEFAULT 90 CHECK (score_weight BETWEEN 0 AND 100),
  reason text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_a, category_b)
);

INSERT INTO style_category_matrix(id, category_a, category_b, compatible, score_weight, reason) VALUES
  (gen_random_uuid(), 'trousers', 'trousers', false, 15, 'قرار دادن دو شلوار در یک استایل معتبر نیست.'),
  (gen_random_uuid(), 'shoes', 'shoes', false, 10, 'قرار دادن دو کفش در یک استایل معتبر نیست.'),
  (gen_random_uuid(), 'shirt', 'trousers', true, 96, 'ترکیب پیراهن و شلوار ستون اصلی استایل کلاسیک و روزمره است.'),
  (gen_random_uuid(), 'coat', 'shirt', true, 96, 'لایه بیرونی کت/پالتو روی پیراهن توازن سیلوئت عالی ایجاد می‌کند.'),
  (gen_random_uuid(), 'coat', 'trousers', true, 95, 'کت و شلوار تناسب رسمی و نیمه‌رسمی استاندارد دارند.'),
  (gen_random_uuid(), 'trousers', 'shoes', true, 95, 'هماهنگی شلوار و کفش خط عمودی استایل را کامل می‌کند.'),
  (gen_random_uuid(), 'coat', 'shoes', true, 92, 'پالتو/کت با کفش چرمی یا بوت هارمونی فصلی دارد.'),
  (gen_random_uuid(), 'knitwear', 'trousers', true, 94, 'بافت و شلوار پارچه‌ای/کتان ترکیب پاییزی متوازن می‌سازند.'),
  (gen_random_uuid(), 'coat', 'knitwear', true, 93, 'لایه‌بندی پالتو روی پلیور بافت برای فصول سرد ایده‌آل است.'),
  (gen_random_uuid(), 'accessory', 'coat', true, 92, 'اکسسوری جلوه نهایی لایه بیرونی را کامل می‌کند.'),
  (gen_random_uuid(), 'accessory', 'shirt', true, 90, 'اکسسوری مکمل مناسب پیراهن است.'),
  (gen_random_uuid(), 'accessory', 'trousers', true, 94, 'کمربند و اکسسوری چرمی با شلوار هماهنگی مستقیم دارد.'),
  (gen_random_uuid(), 'accessory', 'shoes', true, 95, 'هم‌خوانی چرم اکسسوری و کفش امضای استایل کلاسیک است.')
ON CONFLICT (category_a, category_b) DO NOTHING;

CREATE TABLE IF NOT EXISTS saved_styles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_code text NOT NULL UNIQUE,
  name text NOT NULL,
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private', 'unlisted', 'public')),
  version integer NOT NULL DEFAULT 1,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  score integer NOT NULL DEFAULT 0,
  score_version text NOT NULL DEFAULT 'v1',
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation text NOT NULL DEFAULT '',
  bundle_price_rial bigint NOT NULL DEFAULT 0,
  preview_data_url text,
  derived_vibes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_styles_user_idx ON saved_styles(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS saved_style_versions (
  id uuid PRIMARY KEY,
  style_id uuid NOT NULL REFERENCES saved_styles(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name text NOT NULL,
  items jsonb NOT NULL,
  score integer NOT NULL,
  score_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_id, version)
);

CREATE TABLE IF NOT EXISTS customer_reviews (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  verified_purchase boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX IF NOT EXISTS customer_reviews_product_idx ON customer_reviews(product_id, status, created_at DESC);

-- 9. Unified Profile Domain, Contact OTP Verification, Supplier Approval Diff, Account Security (Req 333-355)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS avatar_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_factor_method text NOT NULL DEFAULT 'sms' CHECK (two_factor_method IN ('sms', 'totp', 'email')),
  ADD COLUMN IF NOT EXISTS loyalty_points integer NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS customer_tier text NOT NULL DEFAULT 'classic';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_code text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS device_label text DEFAULT 'مرورگر وب',
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS login_history (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid,
  ip_address text,
  user_agent text,
  device_label text NOT NULL DEFAULT 'مرورگر وب',
  method text NOT NULL DEFAULT 'password',
  succeeded boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_history_user_idx ON login_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_change_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('phone', 'email', 'password', '2fa')),
  new_value text NOT NULL,
  otp_code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_views (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

ALTER TABLE supplier_profiles
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS public_description text,
  ADD COLUMN IF NOT EXISTS contact_person text;

CREATE TABLE IF NOT EXISTS supplier_profile_change_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_version integer NOT NULL,
  current_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  diff jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected')),
  supplier_note text,
  review_note text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_profile_changes_user_idx ON supplier_profile_change_requests(user_id, status, created_at DESC);

-- Granular CMS & Style permissions (Req 232)
INSERT INTO permissions(code, title) VALUES
  ('cms:edit', 'ویرایش پیش‌نویس و صفحات CMS'),
  ('cms:publish', 'انتشار و زمان‌بندی صفحات CMS'),
  ('cms:templates', 'مدیریت قالب‌های کارت و بخش‌های CMS'),
  ('cms:theme', 'مدیریت تم و توکن‌های طراحی سایت'),
  ('cms:components', 'ساخت و مدیریت کامپوننت‌های CMS'),
  ('cms:media', 'مدیریت کتابخانه رسانه CMS'),
  ('style:manage', 'مدیریت هوش استایل‌بیلدر و ماتریس سازگاری')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'cms:edit'),
  ('admin', 'cms:publish'),
  ('admin', 'cms:templates'),
  ('admin', 'cms:theme'),
  ('admin', 'cms:components'),
  ('admin', 'cms:media'),
  ('admin', 'style:manage')
ON CONFLICT DO NOTHING;
