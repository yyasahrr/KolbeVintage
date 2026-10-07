-- Commerce requirements batch (docs/KOLBE_REQUIREMENTS_1-356_FA.md):
-- items 4-10 (product types + sizes), 35-36 (owner/channel), 3 (review reasons),
-- 46-48 (installment policy), 49/83 (variant weight), 245-247 (gender/season),
-- 45 (migrated users must reset password).

-- ---------- Product types + sizes (items 4-10) ----------
CREATE TABLE IF NOT EXISTS product_types (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_type_sizes (
  id uuid PRIMARY KEY,
  product_type_id uuid NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 40),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_type_id, code)
);
CREATE INDEX IF NOT EXISTS product_type_sizes_type_idx ON product_type_sizes(product_type_id, position);

-- ---------- Products: type link, owner/channel, policy, moq, gender (3,35,36,46-48,245) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='product_type_id') THEN
    ALTER TABLE products ADD COLUMN product_type_id uuid REFERENCES product_types(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='owner_type') THEN
    ALTER TABLE products ADD COLUMN owner_type text NOT NULL DEFAULT 'kolbe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='retail_enabled') THEN
    ALTER TABLE products ADD COLUMN retail_enabled boolean NOT NULL DEFAULT true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='wholesale_enabled') THEN
    ALTER TABLE products ADD COLUMN wholesale_enabled boolean NOT NULL DEFAULT true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='installment_policy') THEN
    ALTER TABLE products ADD COLUMN installment_policy text NOT NULL DEFAULT 'enabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='wholesale_moq') THEN
    ALTER TABLE products ADD COLUMN wholesale_moq integer CHECK (wholesale_moq IS NULL OR wholesale_moq >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='gender_code') THEN
    ALTER TABLE products ADD COLUMN gender_code text;
  END IF;
END $$;

-- Backfill ownership from the legacy supplier_id signal.
UPDATE products SET owner_type = CASE WHEN supplier_id IS NULL THEN 'kolbe' ELSE 'supplier' END;
UPDATE products SET retail_enabled = false, wholesale_enabled = true WHERE owner_type = 'supplier';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_owner_type_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_owner_type_check CHECK (owner_type IN ('kolbe', 'supplier'));
  END IF;
  -- Item 35: a supplier product is wholesale-only — enforced by the database,
  -- not just the UI. No API call can smuggle a supplier product into retail.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_supplier_channel_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_supplier_channel_check
      CHECK (owner_type = 'kolbe' OR (retail_enabled = false AND wholesale_enabled = true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_installment_policy_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_installment_policy_check
      CHECK (installment_policy IN ('disabled', 'enabled', 'disabled_when_discounted', 'enabled_when_discounted'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS products_owner_channel_idx ON products(owner_type, retail_enabled, wholesale_enabled) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS products_type_idx ON products(product_type_id);

-- ---------- Gender / season taxonomies (items 245-247) ----------
CREATE TABLE IF NOT EXISTS product_taxonomies (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('gender', 'season')),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_seasons (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  season_code text NOT NULL,
  PRIMARY KEY (product_id, season_code)
);
INSERT INTO product_taxonomies(id, kind, code, label, position) VALUES
  ('a1000000-0001-4000-8000-000000000001', 'gender', 'male', 'مردانه', 1),
  ('a1000000-0002-4000-8000-000000000002', 'gender', 'female', 'زنانه', 2),
  ('a1000000-0003-4000-8000-000000000003', 'gender', 'unisex', 'یونیسکس', 3),
  ('a1000000-0004-4000-8000-000000000004', 'gender', 'kids', 'بچگانه', 4),
  ('a1000000-0011-4000-8000-000000000011', 'season', 'spring', 'بهار', 1),
  ('a1000000-0012-4000-8000-000000000012', 'season', 'summer', 'تابستان', 2),
  ('a1000000-0013-4000-8000-000000000013', 'season', 'autumn', 'پاییز', 3),
  ('a1000000-0014-4000-8000-000000000014', 'season', 'winter', 'زمستان', 4),
  ('a1000000-0015-4000-8000-000000000015', 'season', 'all-season', 'تمام فصول', 5)
ON CONFLICT (code) DO NOTHING;

-- ---------- Variant weight (item 83) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_variants' AND column_name='weight_grams') THEN
    ALTER TABLE product_variants ADD COLUMN weight_grams integer CHECK (weight_grams IS NULL OR weight_grams >= 0);
  END IF;
END $$;

-- ---------- Review reasons (item 3) ----------
CREATE TABLE IF NOT EXISTS product_review_reasons (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 200),
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0
);
INSERT INTO product_review_reasons(id, code, label, position) VALUES
  ('b2000000-0001-4000-8000-000000000001', 'bad-images', 'تصاویر محصول مناسب نیست.', 1),
  ('b2000000-0002-4000-8000-000000000002', 'low-image-quality', 'کیفیت تصاویر کافی نیست.', 2),
  ('b2000000-0003-4000-8000-000000000003', 'incomplete-info', 'اطلاعات محصول ناقص است.', 3),
  ('b2000000-0004-4000-8000-000000000004', 'bad-description', 'توضیحات محصول نیاز به اصلاح دارد.', 4),
  ('b2000000-0005-4000-8000-000000000005', 'pricing-policy', 'قیمت‌گذاری با ضوابط بازارچه منطبق نیست.', 5),
  ('b2000000-0006-4000-8000-000000000006', 'bad-wholesale-price', 'قیمت عمده مناسب نیست.', 6),
  ('b2000000-0007-4000-8000-000000000007', 'incomplete-sizes', 'مشخصات سایز ناقص است.', 7),
  ('b2000000-0008-4000-8000-000000000008', 'incomplete-colors', 'مشخصات رنگ ناقص است.', 8),
  ('b2000000-0009-4000-8000-000000000009', 'wrong-category', 'دسته‌بندی محصول اشتباه است.', 9),
  ('b2000000-0010-4000-8000-000000000010', 'sku-variant-issues', 'SKU / واریانت‌ها نیاز به اصلاح دارند.', 10),
  ('b2000000-0011-4000-8000-000000000011', 'incomplete-wholesale-terms', 'شرایط فروش عمده کامل نیست.', 11),
  ('b2000000-0012-4000-8000-000000000012', 'bad-moq', 'حداقل سفارش مناسب تعریف نشده.', 12),
  ('b2000000-0013-4000-8000-000000000013', 'incomplete-brand-docs', 'مدارک یا اطلاعات برند ناقص است.', 13),
  ('b2000000-0014-4000-8000-000000000014', 'other', 'سایر موارد.', 14)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_reviews' AND column_name='reason_code') THEN
    ALTER TABLE product_reviews ADD COLUMN reason_code text REFERENCES product_review_reasons(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='product_reviews' AND column_name='reason_label') THEN
    ALTER TABLE product_reviews ADD COLUMN reason_label text;
  END IF;
END $$;

-- ---------- Order pricing snapshot (item 48) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='pricing_snapshot') THEN
    ALTER TABLE orders ADD COLUMN pricing_snapshot jsonb;
  END IF;
END $$;

-- ---------- Migrated users must set a password (item 45) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='must_reset_password') THEN
    ALTER TABLE users ADD COLUMN must_reset_password boolean NOT NULL DEFAULT false;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id);

-- ---------- Permissions ----------
INSERT INTO permissions(code, title) VALUES
  ('catalog:structure', 'مدیریت ساختار محصول (نوع، مشخصات، راهنمای سایز)'),
  ('imports:manage', 'مدیریت مرکز ورود و مهاجرت داده')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'catalog:structure'), ('admin', 'imports:manage'),
  ('operations', 'catalog:structure'), ('operations', 'imports:manage')
ON CONFLICT DO NOTHING;

-- Seed a few product types so the editor has real data on a fresh database.
INSERT INTO product_types(id, code, name, description, position) VALUES
  ('c3000000-0001-4000-8000-000000000001', 'tshirt', 'تی‌شرت', '', 1),
  ('c3000000-0002-4000-8000-000000000002', 'shoes', 'کفش', '', 2),
  ('c3000000-0003-4000-8000-000000000003', 'pants', 'شلوار', '', 3),
  ('c3000000-0004-4000-8000-000000000004', 'coat', 'کت / مانتو', '', 4)
ON CONFLICT (code) DO NOTHING;
INSERT INTO product_type_sizes(id, product_type_id, code, label, position)
SELECT ('c3000000-0011-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid,
  'c3000000-0001-4000-8000-000000000001', g.code, g.code, g.n
FROM (VALUES (1,'XS'),(2,'S'),(3,'M'),(4,'L'),(5,'XL'),(6,'2XL'),(7,'3XL')) AS g(n, code)
ON CONFLICT (product_type_id, code) DO NOTHING;
INSERT INTO product_type_sizes(id, product_type_id, code, label, position)
SELECT ('c3000000-0022-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid,
  'c3000000-0002-4000-8000-000000000002', g.code, g.code, g.n
FROM (VALUES (1,'36'),(2,'37'),(3,'38'),(4,'39'),(5,'40'),(6,'41'),(7,'42'),(8,'43'),(9,'44')) AS g(n, code)
ON CONFLICT (product_type_id, code) DO NOTHING;
