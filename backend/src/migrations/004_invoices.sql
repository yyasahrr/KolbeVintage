-- Unified transactional document numbering (item 27: reference numbers).
CREATE TABLE document_sequences (
  document_type text PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Shared invoice module (items 35-36). One engine for retail, wholesale,
-- supplier purchases, settlements, refunds, returns and installments.
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('retail_sale', 'wholesale_sale', 'supplier_purchase', 'settlement',
    'refund', 'return_credit', 'installment_plan', 'other')),
  order_id uuid REFERENCES orders(id),
  revises_invoice_id uuid REFERENCES invoices(id),
  buyer jsonb NOT NULL DEFAULT '{}'::jsonb,
  seller jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid',
    'cancelled', 'credited', 'revised')),
  payment_type text NOT NULL DEFAULT 'cash' CHECK (payment_type IN ('cash', 'four_installments', 'transfer',
    'credit', 'wallet', 'mixed')),
  currency char(3) NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
  subtotal_rial bigint NOT NULL DEFAULT 0 CHECK (subtotal_rial >= 0),
  discount_rial bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
  tax_rial bigint NOT NULL DEFAULT 0 CHECK (tax_rial >= 0),
  shipping_rial bigint NOT NULL DEFAULT 0 CHECK (shipping_rial >= 0),
  services_fee_rial bigint NOT NULL DEFAULT 0 CHECK (services_fee_rial >= 0),
  gross_rial bigint NOT NULL DEFAULT 0 CHECK (gross_rial >= 0),
  total_rial bigint NOT NULL DEFAULT 0 CHECK (total_rial >= 0),
  paid_rial bigint NOT NULL DEFAULT 0 CHECK (paid_rial >= 0),
  remaining_rial bigint NOT NULL DEFAULT 0,
  issue_date date NOT NULL DEFAULT current_date,
  due_date date,
  paid_at timestamptz,
  notes text,
  created_by uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining_rial = total_rial - paid_rial),
  CHECK (paid_rial <= total_rial)
);
CREATE INDEX invoices_order_idx ON invoices(order_id);
CREATE INDEX invoices_status_created_idx ON invoices(status, created_at DESC);
CREATE INDEX invoices_kind_created_idx ON invoices(kind, created_at DESC);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  line_no integer NOT NULL,
  sku text,
  product_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  unit_price_rial bigint NOT NULL CHECK (unit_price_rial >= 0),
  discount_rial bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
  tax_rial bigint NOT NULL DEFAULT 0 CHECK (tax_rial >= 0),
  line_total_rial bigint NOT NULL CHECK (line_total_rial >= 0),
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  reference text NOT NULL UNIQUE,
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  method text NOT NULL DEFAULT 'transfer' CHECK (method IN ('cash', 'transfer', 'card', 'wallet', 'gateway', 'cheque', 'other')),
  trace_code text,
  note text,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_invoice_idx ON invoice_payments(invoice_id, created_at);

-- Append-only financial history (item 36). Previous records are never lost.
CREATE TABLE invoice_events (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  event_type text NOT NULL CHECK (event_type IN ('created', 'amount_corrected', 'discount_added', 'payment',
    'partial_payment', 'cancelled', 'refunded', 'status_changed', 'credit_note', 'revised')),
  actor_id uuid REFERENCES users(id),
  note text,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_events_invoice_idx ON invoice_events(invoice_id, created_at);
CREATE TRIGGER invoice_events_immutable BEFORE UPDATE OR DELETE ON invoice_events
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

-- Ledger accounts used by invoice postings.
INSERT INTO ledger_accounts(id, code, title, account_type) VALUES
  ('00000000-0000-4000-8000-000000000003', 'RECEIVABLE', 'حساب‌های دریافتنی', 'asset'),
  ('00000000-0000-4000-8000-000000000004', 'SUPPLIER_PAYABLE', 'حساب‌های پرداختنی تأمین‌کنندگان', 'liability'),
  ('00000000-0000-4000-8000-000000000005', 'SALES_REVENUE', 'درآمد فروش', 'revenue'),
  ('00000000-0000-4000-8000-000000000006', 'SHIPPING_INCOME', 'درآمد ارسال', 'revenue'),
  ('00000000-0000-4000-8000-000000000007', 'SERVICES_INCOME', 'درآمد خدمات', 'revenue'),
  ('00000000-0000-4000-8000-000000000008', 'DISCOUNT_EXPENSE', 'هزینه تخفیف', 'expense'),
  ('00000000-0000-4000-8000-000000000009', 'TAX_PAYABLE', 'مالیات پرداختنی', 'liability'),
  ('00000000-0000-4000-8000-000000000010', 'SUPPLIER_COST', 'بهای تمام‌شده خرید از تأمین‌کننده', 'expense')
ON CONFLICT DO NOTHING;

-- Fine-grained permissions for the financial module.
INSERT INTO permissions(code, title) VALUES
  ('invoices:read', 'مشاهده فاکتورها'), ('invoices:write', 'ایجاد و اصلاح فاکتور'),
  ('finance:manage', 'مدیریت مالی و تسویه'), ('plans:manage', 'مدیریت پلن‌های عضویت'),
  ('suppliers:manage', 'مدیریت تأمین‌کنندگان'), ('crm:manage', 'مدیریت CRM'),
  ('coupons:manage', 'مدیریت کوپن و جشنواره'), ('cms:manage', 'مدیریت محتوای سایت'),
  ('integrations:manage', 'مدیریت اتصال‌ها'), ('logs:read', 'مشاهده گزارش رویدادها'),
  ('tickets:transition', 'تغییر وضعیت تیکت')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'invoices:read'), ('admin', 'invoices:write'), ('admin', 'finance:manage'),
  ('admin', 'plans:manage'), ('admin', 'suppliers:manage'), ('admin', 'crm:manage'),
  ('admin', 'coupons:manage'), ('admin', 'cms:manage'), ('admin', 'integrations:manage'),
  ('admin', 'logs:read'), ('admin', 'tickets:transition'),
  ('finance', 'invoices:read'), ('finance', 'invoices:write'), ('finance', 'finance:manage'),
  ('operations', 'invoices:read'), ('support', 'invoices:read'), ('support', 'tickets:transition')
ON CONFLICT DO NOTHING;
