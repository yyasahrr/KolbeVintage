-- Import / migration center (docs items 37-45) + shipping pricing rules (83-84).

-- ---------- Import jobs ----------
CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('products','inventory','users')),
  filename text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv','xlsx','xls','zip')),
  mode text NOT NULL CHECK (mode IN ('create_only','update','create_update')),
  match_by text NOT NULL CHECK (match_by IN ('sku','legacy_id','email','phone','product_code')),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  succeeded_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  warning_rows integer NOT NULL DEFAULT 0,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_csv text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS import_job_rows (
  job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed','skipped')),
  message text,
  PRIMARY KEY (job_id, row_number)
);
CREATE INDEX IF NOT EXISTS import_job_rows_status_idx ON import_job_rows(job_id, status);

-- Stable external keys for idempotent re-imports (item 42).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='import_key') THEN
    ALTER TABLE products ADD COLUMN import_key text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='import_key') THEN
    ALTER TABLE users ADD COLUMN import_key text;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS products_import_key_uniq ON products(import_key) WHERE import_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_import_key_uniq ON users(import_key) WHERE import_key IS NOT NULL;

-- ---------- Shipping pricing rules (items 83-84) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shipping_methods' AND column_name='pricing_type') THEN
    ALTER TABLE shipping_methods ADD COLUMN pricing_type text NOT NULL DEFAULT 'flat';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipping_methods_pricing_type_check') THEN
    ALTER TABLE shipping_methods ADD CONSTRAINT shipping_methods_pricing_type_check
      CHECK (pricing_type IN ('flat','weight','free','order_value','destination','carrier'));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS shipping_price_rules (
  id uuid PRIMARY KEY,
  method_id uuid NOT NULL REFERENCES shipping_methods(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('flat','weight','free','order_value','destination')),
  min_weight_grams integer CHECK (min_weight_grams IS NULL OR min_weight_grams >= 0),
  max_weight_grams integer CHECK (max_weight_grams IS NULL OR max_weight_grams >= 0),
  min_order_rial bigint CHECK (min_order_rial IS NULL OR min_order_rial >= 0),
  max_order_rial bigint CHECK (max_order_rial IS NULL OR max_order_rial >= 0),
  province text,
  city text,
  fee_rial bigint NOT NULL CHECK (fee_rial >= 0),
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipping_price_rules_method_idx ON shipping_price_rules(method_id, position);

-- Seed weight tiers for the post method (item 83 example).
INSERT INTO shipping_price_rules(id, method_id, rule_type, min_weight_grams, max_weight_grams, fee_rial, position)
SELECT ('e5000000-000' || g.n || '-4000-8000-00000000000' || g.n)::uuid,
  '5b1c9a10-0001-4a11-8c01-000000000001', 'weight', g.min_w, g.max_w, g.fee, g.n
FROM (VALUES
  (1, 0, 500, 800000),
  (2, 501, 1000, 1100000),
  (3, 1001, 2000, 1600000),
  (4, 2001, 5000, 2500000)
) AS g(n, min_w, max_w, fee)
ON CONFLICT (id) DO NOTHING;
UPDATE shipping_methods SET pricing_type = 'weight'
WHERE code = 'post' AND pricing_type = 'flat'
  AND EXISTS (SELECT 1 FROM shipping_price_rules WHERE method_id = shipping_methods.id);
