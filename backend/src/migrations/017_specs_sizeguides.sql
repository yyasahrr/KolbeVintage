-- Dynamic product specifications + size guides (docs items 122-135).

-- ---------- Spec attributes (items 122-123, 128) ----------
CREATE TABLE IF NOT EXISTS spec_attributes (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,60}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('text','textarea','number','decimal','boolean','single_select','multi_select','color','date','measurement','file','image','video','url')),
  unit text,
  required boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'product' CHECK (scope IN ('product','variant')),
  position integer NOT NULL DEFAULT 0,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS spec_attribute_options (
  id uuid PRIMARY KEY,
  attribute_id uuid NOT NULL REFERENCES spec_attributes(id) ON DELETE CASCADE,
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 120),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 0,
  UNIQUE (attribute_id, value)
);
CREATE INDEX IF NOT EXISTS spec_attribute_options_attr_idx ON spec_attribute_options(attribute_id, position);

-- ---------- Spec templates + groups (items 124-126) ----------
CREATE TABLE IF NOT EXISTS spec_templates (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,60}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS spec_attribute_groups (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES spec_templates(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  position integer NOT NULL DEFAULT 0,
  UNIQUE (template_id, name)
);
CREATE TABLE IF NOT EXISTS spec_template_attributes (
  template_id uuid NOT NULL REFERENCES spec_templates(id) ON DELETE CASCADE,
  attribute_id uuid NOT NULL REFERENCES spec_attributes(id) ON DELETE RESTRICT,
  group_id uuid REFERENCES spec_attribute_groups(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, attribute_id)
);

-- Item 125: product type -> default specification template.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_types' AND column_name='spec_template_id') THEN
    ALTER TABLE product_types ADD COLUMN spec_template_id uuid REFERENCES spec_templates(id);
  END IF;
END $$;

-- ---------- Product spec values (items 127-128) ----------
CREATE TABLE IF NOT EXISTS product_spec_values (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  attribute_id uuid NOT NULL REFERENCES spec_attributes(id) ON DELETE RESTRICT,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((variant_id IS NULL) OR (variant_id IS NOT NULL))
);
-- One value per (product, attribute) at product level, one per (product, variant, attribute) at variant level.
CREATE UNIQUE INDEX IF NOT EXISTS product_spec_values_product_uniq
  ON product_spec_values(product_id, attribute_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_spec_values_variant_uniq
  ON product_spec_values(product_id, variant_id, attribute_id) WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_spec_values_product_idx ON product_spec_values(product_id);

-- ---------- Size guides (items 129-134) ----------
CREATE TABLE IF NOT EXISTS size_guides (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,60}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id uuid REFERENCES size_guides(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS size_guide_columns (
  id uuid PRIMARY KEY,
  guide_id uuid NOT NULL REFERENCES size_guides(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_-]{1,60}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  unit text,
  position integer NOT NULL DEFAULT 0,
  UNIQUE (guide_id, code)
);
CREATE TABLE IF NOT EXISTS size_guide_rows (
  id uuid PRIMARY KEY,
  guide_id uuid NOT NULL REFERENCES size_guides(id) ON DELETE CASCADE,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS size_guide_rows_guide_idx ON size_guide_rows(guide_id, position);
CREATE TABLE IF NOT EXISTS size_guide_media (
  id uuid PRIMARY KEY,
  guide_id uuid NOT NULL REFERENCES size_guides(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('image','diagram','video','gif')),
  caption text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0
);
-- Item 132: link (follows template updates) vs detached (independent copy).
CREATE TABLE IF NOT EXISTS product_size_guides (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE PRIMARY KEY,
  guide_id uuid NOT NULL REFERENCES size_guides(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('link','detached')),
  detached_snapshot jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Seed: winter-apparel spec template + jacket size guide ----------
INSERT INTO spec_attributes(id, code, label, type, position, filterable) VALUES
  ('d4000000-0001-4000-8000-000000000001', 'fabric', 'جنس پارچه', 'single_select', 1, true),
  ('d4000000-0002-4000-8000-000000000002', 'fit', 'فرم لباس', 'single_select', 2, true),
  ('d4000000-0003-4000-8000-000000000003', 'care', 'نحوه شست‌وشو', 'textarea', 3, false),
  ('d4000000-0004-4000-8000-000000000004', 'origin_country', 'کشور تولید', 'text', 4, false),
  ('d4000000-0005-4000-8000-000000000005', 'weight', 'وزن', 'measurement', 5, false)
ON CONFLICT (code) DO NOTHING;
UPDATE spec_attributes SET unit = 'گرم' WHERE code = 'weight';
INSERT INTO spec_attribute_options(id, attribute_id, value, label, position) VALUES
  ('d4000000-0011-4000-8000-000000000001', 'd4000000-0001-4000-8000-000000000001', 'cotton', 'نخ', 1),
  ('d4000000-0012-4000-8000-000000000002', 'd4000000-0001-4000-8000-000000000001', 'cotton-blend', 'پنبه', 2),
  ('d4000000-0013-4000-8000-000000000003', 'd4000000-0001-4000-8000-000000000001', 'linen', 'کتان', 3),
  ('d4000000-0014-4000-8000-000000000004', 'd4000000-0001-4000-8000-000000000001', 'wool', 'پشم', 4),
  ('d4000000-0015-4000-8000-000000000005', 'd4000000-0001-4000-8000-000000000001', 'polyester', 'پلی‌استر', 5),
  ('d4000000-0016-4000-8000-000000000006', 'd4000000-0001-4000-8000-000000000001', 'leather', 'چرم', 6),
  ('d4000000-0021-4000-8000-000000000021', 'd4000000-0002-4000-8000-000000000002', 'regular', 'راسته', 1),
  ('d4000000-0022-4000-8000-000000000022', 'd4000000-0002-4000-8000-000000000002', 'slim', 'اسلیم', 2),
  ('d4000000-0023-4000-8000-000000000023', 'd4000000-0002-4000-8000-000000000002', 'oversize', 'اور‌سایز', 3)
ON CONFLICT (attribute_id, value) DO NOTHING;
INSERT INTO spec_templates(id, code, name, description) VALUES
  ('d4000000-0100-4000-8000-000000000100', 'winter-apparel', 'مشخصات پوشاک زمستانی', 'قالب نمونه برای کاپشن و لباس زمستانی')
ON CONFLICT (code) DO NOTHING;
INSERT INTO spec_attribute_groups(id, template_id, name, position) VALUES
  ('d4000000-0201-4000-8000-000000000201', 'd4000000-0100-4000-8000-000000000100', 'اطلاعات عمومی', 1),
  ('d4000000-0202-4000-8000-000000000202', 'd4000000-0100-4000-8000-000000000100', 'ویژگی‌های فنی', 2),
  ('d4000000-0203-4000-8000-000000000203', 'd4000000-0100-4000-8000-000000000100', 'نگهداری', 3)
ON CONFLICT (template_id, name) DO NOTHING;
INSERT INTO spec_template_attributes(template_id, attribute_id, group_id, position) VALUES
  ('d4000000-0100-4000-8000-000000000100', 'd4000000-0001-4000-8000-000000000001', 'd4000000-0201-4000-8000-000000000201', 1),
  ('d4000000-0100-4000-8000-000000000100', 'd4000000-0002-4000-8000-000000000002', 'd4000000-0201-4000-8000-000000000201', 2),
  ('d4000000-0100-4000-8000-000000000100', 'd4000000-0004-4000-8000-000000000004', 'd4000000-0201-4000-8000-000000000201', 3),
  ('d4000000-0100-4000-8000-000000000100', 'd4000000-0005-4000-8000-000000000005', 'd4000000-0202-4000-8000-000000000202', 4),
  ('d4000000-0100-4000-8000-000000000100', 'd4000000-0003-4000-8000-000000000003', 'd4000000-0203-4000-8000-000000000203', 5)
ON CONFLICT (template_id, attribute_id) DO NOTHING;
UPDATE product_types SET spec_template_id = 'd4000000-0100-4000-8000-000000000100' WHERE code = 'coat';

INSERT INTO size_guides(id, code, name, description, version) VALUES
  ('d4000000-0300-4000-8000-000000000300', 'men-jacket-standard-v1', 'راهنمای سایز کاپشن مردانه (استاندارد v1)', 'الگوی استاندارد کاپشن مردانه', 1)
ON CONFLICT (code) DO NOTHING;
INSERT INTO size_guide_columns(id, guide_id, code, label, unit, position) VALUES
  ('d4000000-0311-4000-8000-000000000311', 'd4000000-0300-4000-8000-000000000300', 'size', 'سایز', NULL, 1),
  ('d4000000-0312-4000-8000-000000000312', 'd4000000-0300-4000-8000-000000000300', 'chest', 'عرض سینه', 'سانتی‌متر', 2),
  ('d4000000-0313-4000-8000-000000000313', 'd4000000-0300-4000-8000-000000000300', 'length', 'قد لباس', 'سانتی‌متر', 3),
  ('d4000000-0314-4000-8000-000000000314', 'd4000000-0300-4000-8000-000000000300', 'shoulder', 'عرض شانه', 'سانتی‌متر', 4),
  ('d4000000-0315-4000-8000-000000000315', 'd4000000-0300-4000-8000-000000000300', 'sleeve', 'قد آستین', 'سانتی‌متر', 5)
ON CONFLICT (guide_id, code) DO NOTHING;
INSERT INTO size_guide_rows(id, guide_id, values, position) VALUES
  ('d4000000-0321-4000-8000-000000000321', 'd4000000-0300-4000-8000-000000000300', '{"size":"M","chest":"54","length":"70","shoulder":"46","sleeve":"63"}', 1),
  ('d4000000-0322-4000-8000-000000000322', 'd4000000-0300-4000-8000-000000000300', '{"size":"L","chest":"57","length":"72","shoulder":"48","sleeve":"64"}', 2),
  ('d4000000-0323-4000-8000-000000000323', 'd4000000-0300-4000-8000-000000000300', '{"size":"XL","chest":"60","length":"74","shoulder":"50","sleeve":"65"}', 3)
ON CONFLICT (id) DO NOTHING;
