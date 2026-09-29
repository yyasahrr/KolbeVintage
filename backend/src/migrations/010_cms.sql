-- CMS building blocks (items 18-22): component registry, page builder with
-- ordering, scheduled color palettes and the floating support widget.
CREATE TABLE cms_components (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  component_type text NOT NULL CHECK (component_type IN ('hero', 'banner', 'product_slider', 'category_section',
    'promotional', 'text_image', 'cta', 'faq', 'blog_section', 'brand_section', 'custom')),
  field_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cms_pages (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  path text NOT NULL,
  description text NOT NULL DEFAULT '',
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cms_sections (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES cms_components(id),
  title text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cms_sections_page_idx ON cms_sections(page_id, position);

CREATE TABLE color_palettes (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  occasion text,
  colors jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (colors ? 'primary' AND colors ? 'secondary' AND colors ? 'accent'
    AND colors ? 'background' AND colors ? 'surface' AND colors ? 'text')
);

CREATE TABLE palette_activations (
  id uuid PRIMARY KEY,
  palette_id uuid NOT NULL REFERENCES color_palettes(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('manual', 'scheduled', 'festival')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  festival_id uuid REFERENCES festivals(id),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'festival' OR festival_id IS NOT NULL)
);
CREATE INDEX palette_activations_window_idx ON palette_activations(starts_at, ends_at) WHERE active;

CREATE TABLE site_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_components(id, code, title, component_type) VALUES
  (gen_random_uuid(), 'hero', 'هدر اصلی (Hero)', 'hero'),
  (gen_random_uuid(), 'banner', 'بنر', 'banner'),
  (gen_random_uuid(), 'product_slider', 'اسلایدر محصولات', 'product_slider'),
  (gen_random_uuid(), 'category_section', 'بخش دسته‌بندی', 'category_section'),
  (gen_random_uuid(), 'promotional', 'بخش تبلیغاتی', 'promotional'),
  (gen_random_uuid(), 'text_image', 'متن و تصویر', 'text_image'),
  (gen_random_uuid(), 'cta', 'دکمه اقدام (CTA)', 'cta'),
  (gen_random_uuid(), 'faq', 'پرسش‌های متداول', 'faq'),
  (gen_random_uuid(), 'blog_section', 'بخش مقالات', 'blog_section'),
  (gen_random_uuid(), 'brand_section', 'بخش برندها', 'brand_section')
ON CONFLICT (code) DO NOTHING;

INSERT INTO site_settings(key, value) VALUES
  ('support_widget', '{"enabled": true, "position": "left", "channels": [{"type": "ticket", "label": "ثبت تیکت", "value": "/support"}, {"type": "phone", "label": "تماس", "value": "02100000000"}], "appearance": {"color": "#1B2A4A", "size": "medium", "icon": "headset"}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions(code, title) VALUES
  ('cms:read', 'مشاهده محتوای سایت')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'cms:read')
ON CONFLICT DO NOTHING;
