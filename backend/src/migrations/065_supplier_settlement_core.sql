-- 065 — Prompt 3: Supplier Financial Core — child-level payables, settlement holds,
-- scheduled settlement policies, verified bank accounts, manual-transfer evidence,
-- supplier recoveries, provider reconciliation and shipping financial policies.
--
-- Canonical reuse (NO parallel finance engine):
--   * supplier_ledger_entries / journal_entries / journal_lines (027/001) stay the
--     financial source of truth; this migration only adds the payable/settlement
--     orchestration state around them.
--   * settlements / settlement_lines / settlement_exceptions / settlement_events /
--     finance_approvals (005/027) are EXTENDED — new scheduled child-level
--     settlements live in the SAME tables, discriminated by settlements.kind.
--   * wallet_accounts / withdrawal_requests stay for legacy history; the new
--     Supplier money-out path is Payable → Hold → Eligible → Scheduled Settlement
--     → Manual IBAN Transfer → PAID. Normal withdrawals are policy-disabled.
-- Additive only. 063/064 untouched.

-- ============================================================================
-- Settlement policies (§33-§36): configurable schedule semantics, versioned.
-- ============================================================================
CREATE TABLE settlement_policies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  schedule_type text NOT NULL CHECK (schedule_type IN ('weekly', 'monthly', 'month_days', 'manual')),
  -- weekly: 0=Sunday … 6=Saturday (JS getDay semantics, evaluated server-side).
  weekly_day integer CHECK (weekly_day IS NULL OR (weekly_day >= 0 AND weekly_day <= 6)),
  -- month_days: e.g. {15,30}; 'monthly' uses {month_day_single}.
  month_days integer[] NOT NULL DEFAULT '{}',
  minimum_settlement_rial bigint NOT NULL DEFAULT 0 CHECK (minimum_settlement_rial >= 0),
  -- §26: hold duration resolved per policy; NULL = global default from site_settings.
  hold_hours integer CHECK (hold_hours IS NULL OR hold_hours >= 0),
  requires_verified_bank boolean NOT NULL DEFAULT true,
  requires_manual_review boolean NOT NULL DEFAULT true,
  -- §50/§115 hard V1 rule: automatic payout can never be switched on by data.
  automatic_bank_payout boolean NOT NULL DEFAULT false CHECK (automatic_bank_payout = false),
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Default policy (§35): twice monthly on the 15th and 30th.
INSERT INTO settlement_policies(id, name, schedule_type, month_days, minimum_settlement_rial)
VALUES ('00000000-0000-4000-9000-000000000001', 'تسویه دو بار در ماه (۱۵ و ۳۰)', 'month_days', '{15,30}', 0);

-- Supplier override (§35): explicit policy wins, otherwise the default above.
ALTER TABLE supplier_profiles ADD COLUMN settlement_policy_id uuid REFERENCES settlement_policies(id);

-- ============================================================================
-- Verified supplier bank accounts (§43-§49).
-- supplier_profiles.bank_iban stays as legacy profile data; settlements only
-- ever use rows from this table once verified.
-- ============================================================================
CREATE TABLE supplier_bank_accounts (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES users(id),
  bank_name text NOT NULL,
  iban text NOT NULL CHECK (iban ~ '^IR[0-9]{24}$'),
  holder_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'verified', 'rejected', 'disabled', 'archived')),
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  -- §47: optional cooldown — a newly verified account becomes usable for
  -- settlements only after this instant (configurable; equals verified_at when 0).
  settlement_enabled_at timestamptz,
  rejected_reason text,
  security_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (supplier_id, iban)
);
CREATE INDEX supplier_bank_accounts_supplier_idx ON supplier_bank_accounts(supplier_id, status);
CREATE UNIQUE INDEX supplier_bank_accounts_primary_uniq ON supplier_bank_accounts(supplier_id)
  WHERE is_primary AND status NOT IN ('archived', 'rejected');

-- ============================================================================
-- Shipping financial policies (§73-§85): payer per shipping leg, versioned.
-- ============================================================================
CREATE TABLE shipping_financial_policies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  leg text NOT NULL CHECK (leg IN ('supplier_inbound_order', 'supplier_inbound_stock', 'master_final')),
  payer text NOT NULL CHECK (payer IN ('customer', 'supplier', 'kolbe', 'shared', 'promotion')),
  -- shared: supplier bears this percent, remainder follows the leg default side.
  supplier_share_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (supplier_share_percent >= 0 AND supplier_share_percent <= 100),
  -- Only methods backed by data actually available today (§76).
  method text NOT NULL DEFAULT 'fixed' CHECK (method IN ('fixed', 'per_series', 'actual_cost')),
  amount_rial bigint NOT NULL DEFAULT 0 CHECK (amount_rial >= 0),
  -- Optional supplier-specific override; NULL = global default for the leg.
  supplier_id uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipping_financial_policies_leg_idx ON shipping_financial_policies(leg, active, effective_from DESC);

-- §74 defaults: A) order-driven inbound → customer, B) advance-stock inbound →
-- supplier, C) final master shipment → customer.
INSERT INTO shipping_financial_policies(id, name, leg, payer, method, amount_rial) VALUES
  ('00000000-0000-4000-9000-000000000011', 'ارسال تأمین‌کننده به کلبه (سفارش‌محور) — پرداخت مشتری', 'supplier_inbound_order', 'customer', 'fixed', 0),
  ('00000000-0000-4000-9000-000000000012', 'ارسال موجودی امانی تأمین‌کننده به کلبه — پرداخت تأمین‌کننده', 'supplier_inbound_stock', 'supplier', 'fixed', 0),
  ('00000000-0000-4000-9000-000000000013', 'ارسال نهایی کلبه به خریدار VIP — پرداخت مشتری', 'master_final', 'customer', 'fixed', 0);

-- ============================================================================
-- Child-level supplier payables (§10-§17, §97, §120): exactly ONE financial
-- earning unit per delivered supplier child order. The ledger rows stay the
-- source of truth — this table is the orchestration state (hold → eligible →
-- scheduled → settled) plus the immutable calculation snapshot.
-- ============================================================================
CREATE TABLE supplier_child_payables (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES users(id),
  child_order_id uuid NOT NULL REFERENCES orders(id),
  master_order_id uuid REFERENCES master_orders(id),
  -- §16-§17: explainable components; never a bare net.
  gross_rial bigint NOT NULL CHECK (gross_rial >= 0),
  commission_rial bigint NOT NULL DEFAULT 0 CHECK (commission_rial >= 0),
  shipping_share_rial bigint NOT NULL DEFAULT 0 CHECK (shipping_share_rial >= 0),
  refunds_rial bigint NOT NULL DEFAULT 0 CHECK (refunds_rial >= 0),
  adjustments_rial bigint NOT NULL DEFAULT 0,
  net_rial bigint NOT NULL CHECK (net_rial >= 0),
  -- §84: commission snapshot — later contract changes never touch this row.
  commission_percent numeric(5,2) NOT NULL DEFAULT 0,
  -- §78/§82: resolved shipping policy snapshot (id/version/payer/amount/reason).
  shipping_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- §15/§97: per-line quantity trace used for the calculation
  -- (requested/confirmed/dispatched/received/qc_passed/accepted × unit price).
  quantity_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- references into the canonical ledger rows created at accrual.
  ledger_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'blocked', 'eligible', 'scheduled', 'settled', 'cancelled')),
  eligible_at timestamptz,
  settlement_id uuid REFERENCES settlements(id),
  settled_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- §120: one child order can never accrue twice.
  UNIQUE (child_order_id)
);
CREATE INDEX supplier_child_payables_supplier_idx ON supplier_child_payables(supplier_id, status, created_at DESC);
CREATE INDEX supplier_child_payables_settlement_idx ON supplier_child_payables(settlement_id)
  WHERE settlement_id IS NOT NULL;

-- ============================================================================
-- Settlement holds (§24-§31): first-class, policy-driven, partially resolvable.
-- ============================================================================
CREATE TABLE settlement_holds (
  id uuid PRIMARY KEY,
  payable_id uuid NOT NULL REFERENCES supplier_child_payables(id),
  supplier_id uuid NOT NULL REFERENCES users(id),
  child_order_id uuid NOT NULL REFERENCES orders(id),
  -- current held amount: starts at net payable, reduced by partial resolutions (§30).
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'released', 'cancelled')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  release_at timestamptz NOT NULL,
  released_at timestamptz,
  released_by uuid REFERENCES users(id),
  reason text,
  manual_block boolean NOT NULL DEFAULT false,
  blocked_reason text,
  -- §26: resolved hold policy snapshot (source + hours).
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payable_id)
);
CREATE INDEX settlement_holds_due_idx ON settlement_holds(status, release_at);
CREATE INDEX settlement_holds_supplier_idx ON settlement_holds(supplier_id, status);

-- ============================================================================
-- Supplier recoveries (§92-§94): supplier owes Kolbe after a paid settlement —
-- offsets future settlements, never rewrites history, never a negative wallet.
-- ============================================================================
CREATE TABLE supplier_recoveries (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES users(id),
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  offset_rial bigint NOT NULL DEFAULT 0 CHECK (offset_rial >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'offset', 'written_off')),
  source_type text NOT NULL CHECK (source_type IN ('post_settlement_refund', 'chargeback', 'adjustment', 'manual')),
  source_id uuid,
  child_order_id uuid REFERENCES orders(id),
  origin_settlement_id uuid REFERENCES settlements(id),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (offset_rial <= amount_rial)
);
CREATE INDEX supplier_recoveries_supplier_idx ON supplier_recoveries(supplier_id, status);

-- ============================================================================
-- Provider reconciliation (§68-§72, §128-§129): payment success ≠ bank
-- settlement. Source of every reconciliation value is explicit; nothing faked.
-- ============================================================================
CREATE TABLE provider_reconciliations (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  provider_reference text,
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  status text NOT NULL DEFAULT 'unreconciled' CHECK (status IN ('unreconciled', 'matched', 'exception')),
  -- §129: how this value was established.
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('api', 'statement', 'manual')),
  external_reference text,
  statement_batch text,
  checked_at timestamptz,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_intent_id)
);
CREATE INDEX provider_reconciliations_status_idx ON provider_reconciliations(provider, status);

-- ============================================================================
-- settlements / settlement_lines extensions (§38-§56): scheduled child-level
-- settlements share the canonical tables, discriminated by kind.
-- ============================================================================
ALTER TABLE settlements ADD COLUMN kind text NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy', 'scheduled'));
ALTER TABLE settlements ADD COLUMN scheduled_for date;
ALTER TABLE settlements ADD COLUMN policy_id uuid REFERENCES settlement_policies(id);
ALTER TABLE settlements ADD COLUMN policy_version integer;
ALTER TABLE settlements ADD COLUMN policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE settlements ADD COLUMN bank_account_id uuid REFERENCES supplier_bank_accounts(id);
-- §48: immutable destination snapshot (bank name / IBAN / holder / account version).
ALTER TABLE settlements ADD COLUMN bank_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE settlements ADD COLUMN recovery_offset_rial bigint NOT NULL DEFAULT 0 CHECK (recovery_offset_rial >= 0);
-- §52: manual transfer evidence.
ALTER TABLE settlements ADD COLUMN paid_amount_rial bigint CHECK (paid_amount_rial IS NULL OR paid_amount_rial > 0);
ALTER TABLE settlements ADD COLUMN paid_by uuid REFERENCES users(id);
ALTER TABLE settlements ADD COLUMN source_bank text;
ALTER TABLE settlements ADD COLUMN paid_note text;
-- §55: failed manual transfer is a real state.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check CHECK (status IN ('pending', 'approved',
  'processing', 'paid', 'reconciled', 'cancelled', 'failed'));
-- §54: one bank tracking reference closes at most one scheduled settlement.
CREATE UNIQUE INDEX settlements_paid_reference_uniq ON settlements(paid_reference)
  WHERE kind = 'scheduled' AND paid_reference IS NOT NULL;
CREATE INDEX settlements_kind_status_idx ON settlements(kind, status, created_at DESC);

ALTER TABLE settlement_lines ADD COLUMN child_order_id uuid REFERENCES orders(id);
ALTER TABLE settlement_lines ADD COLUMN master_order_id uuid REFERENCES master_orders(id);
ALTER TABLE settlement_lines ADD COLUMN payable_id uuid REFERENCES supplier_child_payables(id);
-- §122/§155: a payable can sit in at most one settlement line (lines of a
-- cancelled settlement release the payable by nulling payable_id).
CREATE UNIQUE INDEX settlement_lines_payable_uniq ON settlement_lines(payable_id)
  WHERE payable_id IS NOT NULL;

-- §95: richer settlement exception taxonomy.
ALTER TABLE settlement_exceptions DROP CONSTRAINT IF EXISTS settlement_exceptions_code_check;
ALTER TABLE settlement_exceptions ADD CONSTRAINT settlement_exceptions_code_check CHECK (code IN (
  'quantity_mismatch', 'returned_quantity', 'cancelled_line', 'commission_mismatch',
  'shipping_discrepancy', 'manual_adjustment', 'payment_dispute', 'qc_shortage',
  'post_delivery_refund', 'bank_reconciliation_mismatch', 'bank_account_unverified', 'supplier_restricted'));

-- §86: future supplier fee taxonomy on adjustments — supported, not activated.
ALTER TABLE financial_adjustments DROP CONSTRAINT IF EXISTS financial_adjustments_category_check;
ALTER TABLE financial_adjustments ADD CONSTRAINT financial_adjustments_category_check CHECK (category IN (
  'manual', 'penalty', 'bonus', 'tax', 'withholding', 'shipping', 'return', 'reversal',
  'storage', 'handling', 'qc', 'fulfillment'));

-- ============================================================================
-- Permissions (reuse canonical RBAC; no parallel permission system).
-- ============================================================================
INSERT INTO permissions(code, title) VALUES
  ('bank:verify', 'تأیید حساب بانکی تأمین‌کننده'),
  ('finance:reconcile', 'مغایرت‌گیری مالی و تطبیق درگاه')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'bank:verify'), ('finance', 'bank:verify'),
  ('admin', 'finance:reconcile'), ('finance', 'finance:reconcile')
ON CONFLICT DO NOTHING;
