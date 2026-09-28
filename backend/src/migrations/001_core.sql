CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  phone varchar(20) UNIQUE,
  email text UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  birthday date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE TABLE roles (code text PRIMARY KEY, title text NOT NULL);
CREATE TABLE permissions (code text PRIMARY KEY, title text NOT NULL);
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES roles(code),
  PRIMARY KEY (user_id, role_code)
);
CREATE TABLE role_permissions (
  role_code text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE supplier_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  brand_name text NOT NULL,
  legal_name text,
  national_id text,
  economic_code text,
  business_phone text,
  bank_iban text,
  cooperation_status text NOT NULL DEFAULT 'pending' CHECK (cooperation_status IN ('pending', 'approved', 'suspended', 'rejected')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE membership_plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  annual_price_rial bigint NOT NULL CHECK (annual_price_rial >= 0),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES membership_plans(id),
  status text NOT NULL CHECK (status IN ('pending_payment', 'active', 'expired', 'cancelled')),
  payment_intent_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_one_active_per_user ON memberships(user_id) WHERE status = 'active';

CREATE TABLE products (
  id uuid PRIMARY KEY,
  supplier_id uuid REFERENCES users(id),
  brand text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'published', 'rejected', 'archived')),
  cash_price_rial bigint NOT NULL CHECK (cash_price_rial >= 0),
  installment_price_rial bigint CHECK (installment_price_rial >= 0),
  wholesale_price_rial bigint CHECK (wholesale_price_rial >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_published_category_idx ON products(category, created_at DESC) WHERE status = 'published';
CREATE TABLE product_variants (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku text NOT NULL UNIQUE,
  size_label text,
  color_label text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE sku_sequence START 100000;
CREATE INDEX product_variants_product_idx ON product_variants(product_id);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES users(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stock_balances (
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  on_hand integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  incoming integer NOT NULL DEFAULT 0 CHECK (incoming >= 0),
  damaged integer NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, warehouse_id),
  CHECK (reserved + damaged <= on_hand)
);
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  on_hand_delta integer NOT NULL DEFAULT 0,
  reserved_delta integer NOT NULL DEFAULT 0,
  incoming_delta integer NOT NULL DEFAULT 0,
  damaged_delta integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  actor_id uuid REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (on_hand_delta <> 0 OR reserved_delta <> 0 OR incoming_delta <> 0 OR damaged_delta <> 0)
);
CREATE INDEX stock_movements_lookup_idx ON stock_movements(variant_id, warehouse_id, created_at DESC);

CREATE SEQUENCE order_reference_seq START 100000;
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  buyer_id uuid NOT NULL REFERENCES users(id),
  order_type text NOT NULL CHECK (order_type IN ('retail', 'wholesale')),
  payment_mode text NOT NULL CHECK (payment_mode IN ('cash', 'four_installments')),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'paid', 'processing', 'preparing', 'ready_to_ship', 'in_transit', 'shipped', 'delivered', 'cancelled', 'returned')),
  currency char(3) NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
  subtotal_rial bigint NOT NULL CHECK (subtotal_rial >= 0),
  shipping_rial bigint NOT NULL DEFAULT 0 CHECK (shipping_rial >= 0),
  discount_rial bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
  total_rial bigint NOT NULL CHECK (total_rial >= 0),
  shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX orders_buyer_created_idx ON orders(buyer_id, created_at DESC);
CREATE INDEX orders_status_created_idx ON orders(status, created_at DESC);
CREATE TABLE order_lines (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  supplier_id uuid REFERENCES users(id),
  product_name text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  unit_price_rial bigint NOT NULL CHECK (unit_price_rial >= 0),
  line_total_rial bigint NOT NULL CHECK (line_total_rial >= 0)
);
CREATE INDEX order_lines_order_idx ON order_lines(order_id);
CREATE TABLE stock_reservations (
  id uuid PRIMARY KEY,
  order_line_id uuid NOT NULL UNIQUE REFERENCES order_lines(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('active', 'consumed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id, created_at);

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  order_id uuid UNIQUE REFERENCES orders(id),
  membership_id uuid UNIQUE REFERENCES memberships(id),
  provider text NOT NULL,
  provider_reference text UNIQUE,
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  CHECK ((order_id IS NOT NULL)::integer + (membership_id IS NOT NULL)::integer = 1)
);
ALTER TABLE memberships ADD CONSTRAINT memberships_payment_intent_fk FOREIGN KEY (payment_intent_id) REFERENCES payment_intents(id);
CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset', 'liability', 'revenue', 'expense')),
  currency char(3) NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR')
);
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);
CREATE TABLE journal_lines (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  debit_rial bigint NOT NULL DEFAULT 0 CHECK (debit_rial >= 0),
  credit_rial bigint NOT NULL DEFAULT 0 CHECK (credit_rial >= 0),
  CHECK ((debit_rial > 0 AND credit_rial = 0) OR (credit_rial > 0 AND debit_rial = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);
CREATE FUNCTION assert_balanced_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; debit_sum numeric; credit_sum numeric; line_count integer;
BEGIN
  target := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(sum(debit_rial), 0), COALESCE(sum(credit_rial), 0), count(*)
    INTO debit_sum, credit_sum, line_count FROM journal_lines WHERE entry_id = target;
  IF line_count < 2 OR debit_sum <> credit_sum THEN
    RAISE EXCEPTION 'Unbalanced journal entry %', target;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balance_insert AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_balanced_entry();
CREATE FUNCTION prevent_financial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial ledger rows are immutable'; END $$;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

CREATE SEQUENCE ticket_reference_seq START 10000;
CREATE TABLE tickets (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  owner_id uuid NOT NULL REFERENCES users(id),
  order_id uuid REFERENCES orders(id),
  subject text NOT NULL,
  category text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'waiting_user', 'answered', 'escalated', 'resolved', 'closed')),
  department text,
  assignee_id uuid REFERENCES users(id),
  sla_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_owner_created_idx ON tickets(owner_id, created_at DESC);
CREATE INDEX tickets_queue_idx ON tickets(status, priority, sla_due_at);
CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  sender_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages(ticket_id, created_at);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;
CREATE TABLE idempotency_records (
  actor_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL,
  key text NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, key)
);

INSERT INTO roles(code, title) VALUES
  ('customer', 'مشتری'), ('supplier', 'تأمین‌کننده'), ('support', 'پشتیبانی'),
  ('operations', 'عملیات'), ('finance', 'مالی'), ('admin', 'مدیر کل')
ON CONFLICT DO NOTHING;
INSERT INTO permissions(code, title) VALUES
  ('products:write', 'ویرایش محصولات'), ('inventory:read', 'مشاهده انبار'),
  ('inventory:adjust', 'اصلاح موجودی'), ('orders:read', 'مشاهده سفارش‌ها'),
  ('orders:transition', 'تغییر وضعیت سفارش'), ('tickets:manage', 'مدیریت تیکت'),
  ('payments:read', 'مشاهده پرداخت‌ها'), ('audit:read', 'مشاهده گزارش حسابرسی'),
  ('users:manage', 'مدیریت کاربران')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code)
  SELECT 'admin', code FROM permissions ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('operations', 'orders:read'), ('operations', 'orders:transition'),
  ('operations', 'inventory:read'), ('support', 'tickets:manage'),
  ('finance', 'payments:read') ON CONFLICT DO NOTHING;
INSERT INTO ledger_accounts(id, code, title, account_type) VALUES
  ('00000000-0000-4000-8000-000000000001', 'PAYMENT_CLEARING', 'وجوه در مسیر تسویه', 'asset'),
  ('00000000-0000-4000-8000-000000000002', 'CUSTOMER_PREPAYMENT', 'پیش‌دریافت مشتریان', 'liability')
ON CONFLICT DO NOTHING;
