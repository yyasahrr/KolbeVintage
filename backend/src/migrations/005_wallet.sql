-- Supplier/actor wallet and withdrawal lifecycle (items 25, 39-41).
CREATE TABLE wallet_accounts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
  balance_rial bigint NOT NULL DEFAULT 0 CHECK (balance_rial >= 0),
  pending_rial bigint NOT NULL DEFAULT 0 CHECK (pending_rial >= 0),
  earned_total_rial bigint NOT NULL DEFAULT 0 CHECK (earned_total_rial >= 0),
  withdrawn_total_rial bigint NOT NULL DEFAULT 0 CHECK (withdrawn_total_rial >= 0),
  settled_total_rial bigint NOT NULL DEFAULT 0 CHECK (settled_total_rial >= 0),
  refunded_total_rial bigint NOT NULL DEFAULT 0 CHECK (refunded_total_rial >= 0),
  fee_total_rial bigint NOT NULL DEFAULT 0 CHECK (fee_total_rial >= 0),
  commission_total_rial bigint NOT NULL DEFAULT 0 CHECK (commission_total_rial >= 0),
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable wallet ledger; every movement is traceable with a reference (item 39).
CREATE TABLE wallet_entries (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES wallet_accounts(id),
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  kind text NOT NULL CHECK (kind IN ('earning', 'settlement_in', 'settlement_out', 'withdrawal', 'refund',
    'fee', 'commission', 'adjustment')),
  balance_after_rial bigint NOT NULL CHECK (balance_after_rial >= 0),
  reference text NOT NULL UNIQUE,
  source_type text,
  source_id text,
  note text,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entries_account_idx ON wallet_entries(account_id, created_at DESC);
CREATE TRIGGER wallet_entries_immutable BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

CREATE TABLE withdrawal_requests (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES wallet_accounts(id),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'under_review', 'approved',
    'processing', 'paid', 'failed', 'rejected', 'cancelled')),
  destination jsonb NOT NULL DEFAULT '{}'::jsonb,
  reject_reason text,
  provider text,
  provider_reference text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  processed_at timestamptz,
  paid_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawal_requests_account_idx ON withdrawal_requests(account_id, requested_at DESC);
CREATE INDEX withdrawal_requests_status_idx ON withdrawal_requests(status, requested_at DESC);

CREATE TABLE withdrawal_events (
  id uuid PRIMARY KEY,
  withdrawal_id uuid NOT NULL REFERENCES withdrawal_requests(id),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawal_events_idx ON withdrawal_events(withdrawal_id, created_at);
CREATE TRIGGER withdrawal_events_immutable BEFORE UPDATE OR DELETE ON withdrawal_events
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

-- Settlements between the platform and suppliers (item 25).
CREATE TABLE settlements (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  invoice_id uuid REFERENCES invoices(id),
  party_user_id uuid NOT NULL REFERENCES users(id),
  direction text NOT NULL CHECK (direction IN ('payable', 'receivable')),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'settled', 'cancelled')),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX settlements_party_idx ON settlements(party_user_id, created_at DESC);

ALTER TABLE supplier_profiles ADD COLUMN commission_percent numeric(5,2) NOT NULL DEFAULT 0
  CHECK (commission_percent >= 0 AND commission_percent <= 100);

INSERT INTO ledger_accounts(id, code, title, account_type) VALUES
  ('00000000-0000-4000-8000-000000000011', 'WALLET_LIABILITY', 'مانده کیف پول کاربران', 'liability')
ON CONFLICT DO NOTHING;
INSERT INTO permissions(code, title) VALUES
  ('wallet:read', 'مشاهده کیف پول و تراکنش‌ها'), ('withdrawals:manage', 'مدیریت درخواست‌های برداشت'),
  ('settlements:manage', 'مدیریت تسویه‌ها')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'wallet:read'), ('admin', 'withdrawals:manage'), ('admin', 'settlements:manage'),
  ('finance', 'wallet:read'), ('finance', 'withdrawals:manage'), ('finance', 'settlements:manage')
ON CONFLICT DO NOTHING;
