-- 027 — Financial operations (items 144-172)
--
-- Owner: agent B — Supplier 360 / finance branch (reserved range 025-034).
-- Runs after 026; depends on canonical tables from the shared base
-- (001_core journal_entries/journal_lines/ledger_accounts, 004_invoices invoices,
-- 005_wallet settlements, 006_suppliers supplier_profiles) and consumes the
-- canonical product/order domain (orders, order_lines) instead of duplicating it.
--
-- Scope: accounting periods (closed/locked enforcement), ledger dimensions, supplier
-- financial account + append-only statement, settlement engine and reconciliation,
-- advances, adjustments, the approval workflow, shipping cost allocation with a
-- stored rule snapshot and the finance permissions.

-- --------------------------------------------------------- items 144-172 ----
-- Accounting periods (item 169): closed/locked periods accept no new postings.
CREATE TABLE accounting_periods (
  code text PRIMARY KEY CHECK (code ~ '^[0-9]{4}-[0-9]{2}$'),
  title text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

-- Analytic dimensions (item 160) on both the entry and the line.
ALTER TABLE journal_entries ADD COLUMN period_code text REFERENCES accounting_periods(code);
ALTER TABLE journal_entries ADD COLUMN memo text;
ALTER TABLE journal_entries ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE journal_entries ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE journal_lines ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE journal_lines ADD COLUMN supplier_id uuid REFERENCES users(id);
ALTER TABLE journal_lines ADD COLUMN order_id uuid REFERENCES orders(id);
CREATE INDEX journal_entries_period_idx ON journal_entries(period_code, created_at);
CREATE INDEX journal_lines_supplier_idx ON journal_lines(supplier_id) WHERE supplier_id IS NOT NULL;

-- Supplier financial account (items 146, 163): one row per supplier, refreshed
-- from the ledger/statement inside the same transaction as every money movement.
CREATE TABLE supplier_finance_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  gross_sales_rial bigint NOT NULL DEFAULT 0,
  net_sales_rial bigint NOT NULL DEFAULT 0,
  commission_rial bigint NOT NULL DEFAULT 0,
  discount_share_rial bigint NOT NULL DEFAULT 0,
  shipping_charges_rial bigint NOT NULL DEFAULT 0,
  return_costs_rial bigint NOT NULL DEFAULT 0,
  refunds_rial bigint NOT NULL DEFAULT 0,
  adjustments_rial bigint NOT NULL DEFAULT 0,
  penalties_rial bigint NOT NULL DEFAULT 0,
  bonuses_rial bigint NOT NULL DEFAULT 0,
  taxes_rial bigint NOT NULL DEFAULT 0,
  withholding_rial bigint NOT NULL DEFAULT 0,
  pending_payable_rial bigint NOT NULL DEFAULT 0,
  available_payable_rial bigint NOT NULL DEFAULT 0,
  blocked_rial bigint NOT NULL DEFAULT 0,
  settled_rial bigint NOT NULL DEFAULT 0,
  withdrawn_rial bigint NOT NULL DEFAULT 0,
  prepayments_rial bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Supplier statement (item 147): append-only debit/credit lines with a running balance.
CREATE TABLE supplier_ledger_entries (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL CHECK (event IN ('order_sale', 'commission', 'discount_share', 'shipping_charge',
    'return_cost', 'refund', 'adjustment_credit', 'adjustment_debit', 'penalty', 'bonus', 'tax',
    'withholding', 'settlement', 'withdrawal', 'prepayment', 'prepayment_applied')),
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  balance_after_rial bigint NOT NULL,
  reference text NOT NULL,
  description text,
  order_id uuid REFERENCES orders(id),
  order_line_id uuid REFERENCES order_lines(id),
  invoice_id uuid REFERENCES invoices(id),
  settlement_id uuid REFERENCES settlements(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_ledger_supplier_idx ON supplier_ledger_entries(supplier_id, occurred_at DESC, id);
CREATE UNIQUE INDEX supplier_ledger_reference_idx ON supplier_ledger_entries(supplier_id, reference, event);
CREATE TRIGGER supplier_ledger_immutable BEFORE UPDATE OR DELETE ON supplier_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

-- Settlement engine (items 149-155, 158, 159).
ALTER TABLE settlements ADD COLUMN gross_rial bigint NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN commission_rial bigint NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN shipping_rial bigint NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN returns_rial bigint NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN adjustments_rial bigint NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN net_rial bigint NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN period_code text REFERENCES accounting_periods(code);
ALTER TABLE settlements ADD COLUMN approved_by uuid REFERENCES users(id);
ALTER TABLE settlements ADD COLUMN approved_at timestamptz;
ALTER TABLE settlements ADD COLUMN paid_at timestamptz;
ALTER TABLE settlements ADD COLUMN paid_reference text;
ALTER TABLE settlements ADD COLUMN reconciliation_status text NOT NULL DEFAULT 'expected'
  CHECK (reconciliation_status IN ('expected', 'processing', 'paid', 'reconciled', 'mismatch', 'failed'));
ALTER TABLE settlements ADD COLUMN statement_invoice_id uuid REFERENCES invoices(id);
UPDATE settlements SET status = 'paid', paid_at = settled_at WHERE status = 'settled';
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check CHECK (status IN ('pending', 'approved',
  'processing', 'paid', 'reconciled', 'cancelled'));

CREATE TABLE settlement_lines (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  order_reference text NOT NULL,
  order_line_id uuid REFERENCES order_lines(id),
  product_name text NOT NULL,
  quantity integer NOT NULL,
  delivered_at timestamptz,
  gross_rial bigint NOT NULL,
  commission_rial bigint NOT NULL,
  shipping_rial bigint NOT NULL DEFAULT 0,
  returns_rial bigint NOT NULL DEFAULT 0,
  adjustments_rial bigint NOT NULL DEFAULT 0,
  net_rial bigint NOT NULL,
  journal_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_lines_settlement_idx ON settlement_lines(settlement_id);
CREATE INDEX settlement_lines_order_idx ON settlement_lines(order_id);

-- Reconciliation before paying: order vs fulfillment vs payable (item 154).
CREATE TABLE settlement_exceptions (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  order_id uuid REFERENCES orders(id),
  order_line_id uuid REFERENCES order_lines(id),
  code text NOT NULL CHECK (code IN ('quantity_mismatch', 'returned_quantity', 'cancelled_line',
    'commission_mismatch', 'shipping_discrepancy', 'manual_adjustment', 'payment_dispute')),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'blocking')),
  detail text NOT NULL,
  expected_rial bigint,
  found_rial bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'waived')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_exceptions_settlement_idx ON settlement_exceptions(settlement_id, status);

CREATE TABLE settlement_events (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_events_idx ON settlement_events(settlement_id, created_at);
CREATE TRIGGER settlement_events_immutable BEFORE UPDATE OR DELETE ON settlement_events
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

-- Supplier advances / prepayments (item 156).
CREATE TABLE supplier_advances (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES users(id),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  applied_rial bigint NOT NULL DEFAULT 0 CHECK (applied_rial >= 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'reviewed', 'approved', 'paid', 'applied', 'cancelled')),
  reason text NOT NULL,
  note text,
  requested_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  paid_at timestamptz,
  wallet_entry_id uuid REFERENCES wallet_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (applied_rial <= amount_rial)
);

-- Manual financial adjustments (item 157) — never mutate earlier transactions.
CREATE TABLE financial_adjustments (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  supplier_id uuid REFERENCES users(id),
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  category text NOT NULL DEFAULT 'manual' CHECK (category IN ('manual', 'penalty', 'bonus', 'tax',
    'withholding', 'shipping', 'return')),
  reason text NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'reviewed', 'approved', 'applied', 'rejected')),
  requested_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  applied_at timestamptz,
  ledger_entry_id uuid,
  journal_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX financial_adjustments_supplier_idx ON financial_adjustments(supplier_id, created_at DESC);

-- Generic approval workflow for sensitive money operations (item 158).
CREATE TABLE finance_approvals (
  id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('settlement', 'adjustment', 'advance', 'refund', 'withdrawal')),
  subject_id uuid NOT NULL,
  amount_rial bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'reviewed', 'approved', 'paid', 'rejected')),
  requested_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  rejected_by uuid REFERENCES users(id),
  reason text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_approvals_subject_idx ON finance_approvals(subject_type, subject_id);
CREATE TABLE finance_approval_events (
  id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES finance_approvals(id),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER finance_approval_events_immutable BEFORE UPDATE OR DELETE ON finance_approval_events
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

-- Shipping cost allocation across suppliers/lines (items 152-153): the rule and
-- the resulting snapshot are both stored so the number stays explainable.
CREATE TABLE shipping_allocations (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  order_id uuid REFERENCES orders(id),
  shipment_reference text,
  total_cost_rial bigint NOT NULL CHECK (total_cost_rial >= 0),
  total_weight_grams bigint CHECK (total_weight_grams IS NULL OR total_weight_grams >= 0),
  rule text NOT NULL CHECK (rule IN ('weight', 'quantity', 'value', 'volume', 'equal')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shipping_allocation_lines (
  id uuid PRIMARY KEY,
  allocation_id uuid NOT NULL REFERENCES shipping_allocations(id),
  supplier_id uuid REFERENCES users(id),
  order_id uuid REFERENCES orders(id),
  order_line_id uuid REFERENCES order_lines(id),
  basis_value numeric(18,4) NOT NULL DEFAULT 0,
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipping_allocation_lines_allocation_idx ON shipping_allocation_lines(allocation_id);
CREATE INDEX shipping_allocation_lines_supplier_idx ON shipping_allocation_lines(supplier_id);

-- Weight per order line (the shipping engine is weight based; finance traces it).
ALTER TABLE order_lines ADD COLUMN weight_grams integer CHECK (weight_grams IS NULL OR weight_grams >= 0);

-- Extra ledger accounts used by the finance module.
INSERT INTO ledger_accounts(id, code, title, account_type) VALUES
  ('00000000-0000-4000-8000-000000000012', 'MARKETPLACE_COMMISSION', 'درآمد کارمزد بازارچه', 'revenue'),
  ('00000000-0000-4000-8000-000000000013', 'SUPPLIER_ADVANCE', 'پیش‌پرداخت به تأمین‌کنندگان', 'asset'),
  ('00000000-0000-4000-8000-000000000014', 'SHIPPING_EXPENSE', 'هزینه ارسال', 'expense'),
  ('00000000-0000-4000-8000-000000000015', 'REFUND_PAYABLE', 'بازپرداخت‌های پرداختنی', 'liability'),
  ('00000000-0000-4000-8000-000000000016', 'OTHER_INCOME', 'درآمد متفرقه', 'revenue'),
  ('00000000-0000-4000-8000-000000000017', 'PENALTY_INCOME', 'جریمه و کسر از تأمین‌کننده', 'revenue')
ON CONFLICT DO NOTHING;

-- Finance module permissions.
INSERT INTO permissions(code, title) VALUES
  ('invoices:templates', 'مدیریت قالب‌های فاکتور'),
  ('supplier360:read', 'مشاهده پرونده ۳۶۰ درجه تأمین‌کننده'),
  ('supplier360:manage', 'مدیریت وضعیت و محدودیت تأمین‌کننده'),
  ('finance:adjust', 'ثبت اصلاحات مالی'),
  ('finance:approve', 'تأیید عملیات مالی حساس'),
  ('finance:periods', 'مدیریت دوره‌های مالی'),
  ('finance:export', 'خروجی گزارش‌های مالی')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'invoices:templates'), ('admin', 'supplier360:read'), ('admin', 'supplier360:manage'),
  ('admin', 'finance:adjust'), ('admin', 'finance:approve'), ('admin', 'finance:periods'), ('admin', 'finance:export'),
  ('finance', 'invoices:templates'), ('finance', 'supplier360:read'), ('finance', 'supplier360:manage'),
  ('finance', 'finance:adjust'), ('finance', 'finance:approve'), ('finance', 'finance:periods'), ('finance', 'finance:export'),
  ('operations', 'supplier360:read')
ON CONFLICT DO NOTHING;

-- Every supplier keeps exactly one financial account row.
INSERT INTO supplier_finance_accounts(user_id)
SELECT user_id FROM supplier_profiles ON CONFLICT (user_id) DO NOTHING;
