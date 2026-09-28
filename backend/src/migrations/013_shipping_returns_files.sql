-- Shipping methods + Returns reference/history + File storage abstraction (steps 3,4,5,7)
-- Shipping methods
CREATE TABLE IF NOT EXISTS shipping_methods (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  active boolean NOT NULL DEFAULT true,
  type text NOT NULL CHECK (type IN ('standard','express','free','pickup')),
  base_fee_rial bigint NOT NULL CHECK (base_fee_rial >= 0),
  free_above_rial bigint CHECK (free_above_rial IS NULL OR free_above_rial >= 0),
  estimated_min_days integer NOT NULL CHECK (estimated_min_days BETWEEN 0 AND 60),
  estimated_max_days integer NOT NULL CHECK (estimated_max_days BETWEEN 0 AND 60),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (estimated_max_days >= estimated_min_days)
);
CREATE INDEX IF NOT EXISTS shipping_methods_active_idx ON shipping_methods(active);

-- Add shipping_method_id to orders (nullable for backward compat)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='shipping_method_id') THEN
    ALTER TABLE orders ADD COLUMN shipping_method_id uuid REFERENCES shipping_methods(id);
  END IF;
END $$;

-- Return requests: add reference RT-... + history tracking
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='return_requests' AND column_name='reference') THEN
    ALTER TABLE return_requests ADD COLUMN reference text UNIQUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='return_requests' AND column_name='buyer_id') THEN
    ALTER TABLE return_requests ADD COLUMN buyer_id uuid REFERENCES users(id);
  END IF;
  -- Fill buyer_id from requester_id where null
  UPDATE return_requests SET buyer_id = requester_id WHERE buyer_id IS NULL;
END $$;

CREATE SEQUENCE IF NOT EXISTS return_reference_seq START 400000;

-- File storage abstraction (shared for tickets + supplier docs)
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private','public')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_owner_idx ON files(owner_id);

-- Link files to tickets/supplier docs where needed (keep ticket_attachments.file_meta for backward compat, but also link to files)
-- Add file_id to ticket_attachments if not exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ticket_attachments' AND column_name='file_id') THEN
    ALTER TABLE ticket_attachments ADD COLUMN file_id uuid REFERENCES files(id);
  END IF;
END $$;

-- Permissions for shipping/files/returns admin
INSERT INTO permissions(code, title) VALUES
  ('shipping:read', 'مشاهده روش‌های ارسال'),
  ('shipping:manage', 'مدیریت روش‌های ارسال'),
  ('files:read', 'خواندن فایل‌ها'),
  ('files:write', 'آپلود فایل'),
  ('returns:read', 'مشاهده مرجوعی‌ها'),
  ('profile:manage', 'مدیریت پروفایل')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'shipping:read'), ('admin', 'shipping:manage'),
  ('admin', 'files:read'), ('admin', 'files:write'),
  ('admin', 'returns:read'),
  ('operations', 'shipping:read'), ('operations', 'shipping:manage'),
  ('support', 'returns:read'),
  ('customer', 'files:read'), ('customer', 'files:write'),
  ('supplier', 'files:read'), ('supplier', 'files:write')
ON CONFLICT DO NOTHING;

-- Seed default shipping methods (idempotent)
INSERT INTO shipping_methods(id, code, name, active, type, base_fee_rial, free_above_rial, estimated_min_days, estimated_max_days, config)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'post', 'پست پیشتاز', true, 'standard', 300000, 5000000, 2, 4, '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000002', 'express', 'پیک فوری تهران', true, 'express', 500000, null, 0, 1, '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000003', 'pickup', 'تحویل حضوری', true, 'pickup', 0, null, 0, 0, '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;
