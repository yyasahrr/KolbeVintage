-- Requirements 13-16 (manual retail sales as a real commercial domain, off-site
-- channels, card-to-card payment verification, sales channel reporting) and
-- Requirement 30 (persisted product color registry for Product Studio).

-- ---------- Manual sales (Req 13): Sale -> Payment -> Inventory -> Audit ----------
CREATE SEQUENCE IF NOT EXISTS manual_sale_reference_seq START 100001;

CREATE TABLE IF NOT EXISTS manual_sales (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  -- Req 14/16: the commercial channel the sale actually happened on.
  channel text NOT NULL CHECK (channel IN ('website', 'instagram', 'in_person', 'phone', 'whatsapp', 'telegram', 'other')),
  customer_id uuid REFERENCES users(id),
  customer_name text,
  customer_phone text,
  customer_note text NOT NULL DEFAULT '',
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'completed', 'cancelled')),
  subtotal_rial bigint NOT NULL CHECK (subtotal_rial >= 0),
  discount_rial bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
  total_rial bigint NOT NULL CHECK (total_rial >= 0),
  currency char(3) NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
  note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS manual_sales_channel_created_idx ON manual_sales(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS manual_sales_status_created_idx ON manual_sales(status, created_at DESC);
CREATE INDEX IF NOT EXISTS manual_sales_customer_idx ON manual_sales(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_sale_lines (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES manual_sales(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  product_name text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  unit_price_rial bigint NOT NULL CHECK (unit_price_rial >= 0),
  line_total_rial bigint NOT NULL CHECK (line_total_rial >= 0)
);
CREATE INDEX IF NOT EXISTS manual_sale_lines_sale_idx ON manual_sale_lines(sale_id);
CREATE INDEX IF NOT EXISTS manual_sale_lines_variant_idx ON manual_sale_lines(variant_id);

-- Req 15: payments on a manual sale. Card-to-card stays pending until a human
-- verifies the bank trace; cash/POS count as verified on entry.
CREATE TABLE IF NOT EXISTS manual_sale_payments (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES manual_sales(id) ON DELETE RESTRICT,
  payment_method text NOT NULL CHECK (payment_method IN ('card_to_card', 'cash', 'pos', 'gateway', 'other')),
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  reference text,
  paid_at timestamptz,
  verification_status text NOT NULL DEFAULT 'pending_verification'
    CHECK (verification_status IN ('pending_verification', 'verified', 'rejected')),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_sale_payments_sale_idx ON manual_sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS manual_sale_payments_pending_idx ON manual_sale_payments(verification_status, created_at DESC)
  WHERE verification_status = 'pending_verification';

-- ---------- Product color registry (Req 30) ----------
CREATE TABLE IF NOT EXISTS product_colors (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 80),
  hex text NOT NULL DEFAULT '#8A6A4F' CHECK (hex ~* '^#[0-9a-f]{6}$'),
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Permissions ----------
INSERT INTO permissions(code, title) VALUES
  ('sales:manage', 'ثبت و مدیریت فروش دستی (خارج از سایت)'),
  ('sales:read', 'مشاهده فروش‌های دستی')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'sales:manage'), ('admin', 'sales:read'),
  ('operations', 'sales:manage'), ('operations', 'sales:read')
ON CONFLICT DO NOTHING;
