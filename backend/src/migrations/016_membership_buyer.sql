-- Requirements 15-19: membership lifecycle (payment-driven, never admin-driven for
-- paid plans), plan upgrade/downgrade/renew/suspend/refund rules and the complete
-- VIP / wholesale buyer 360 profile with its admin controls.
--
-- Nothing here lets a client or a success page activate a membership: activation is
-- only reachable from applyVerifiedPayment() after a gateway-verified payment.

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('pending_payment', 'active', 'expired', 'cancelled', 'suspended', 'refunded', 'renewed'));
-- A scheduled downgrade is applied server-side when the paid term ends.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS scheduled_plan_id uuid REFERENCES membership_plans(id);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'yearly';
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS upgraded_from uuid REFERENCES memberships(id);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'self_purchase'
  CHECK (source IN ('self_purchase', 'renewal', 'upgrade', 'downgrade', 'admin_grant'));
CREATE INDEX IF NOT EXISTS memberships_user_history_idx ON memberships(user_id, created_at DESC);

-- Plan ordering + upgrade policy live server-side so pricing rules are never duplicated in the UI.
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS tier integer NOT NULL DEFAULT 1;
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'yearly';
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS monthly_price_rial bigint CHECK (monthly_price_rial IS NULL OR monthly_price_rial >= 0);
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS upgrade_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN membership_plans.upgrade_policy IS
  'Server-side money rules: {proration: "unused_credit"|"none", downgradeEffect: "at_expiry"|"immediate", graceDays: int}';

CREATE TABLE IF NOT EXISTS membership_events (
  id uuid PRIMARY KEY,
  membership_id uuid REFERENCES memberships(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN ('payment_pending', 'activated', 'renewed', 'upgraded', 'downgraded',
    'cancelled', 'suspended', 'reactivated', 'expired', 'refunded', 'admin_changed')),
  from_status text,
  to_status text,
  from_plan_id uuid REFERENCES membership_plans(id),
  to_plan_id uuid REFERENCES membership_plans(id),
  amount_rial bigint NOT NULL DEFAULT 0 CHECK (amount_rial >= 0),
  credit_rial bigint NOT NULL DEFAULT 0 CHECK (credit_rial >= 0),
  note text,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS membership_events_user_idx ON membership_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS membership_events_membership_idx ON membership_events(membership_id, created_at DESC);

-- Buyer 360 commercial/legal data (requirement 18) kept separately from the account itself.
CREATE TABLE IF NOT EXISTS buyer_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name text,
  guild_identifier text,
  legal_name text,
  legal_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  activity_type text,
  city text,
  credit_limit_rial bigint NOT NULL DEFAULT 0 CHECK (credit_limit_rial >= 0),
  vip_level text NOT NULL DEFAULT 'none' CHECK (vip_level IN ('none', 'silver', 'gold', 'platinum')),
  approval_policy text NOT NULL DEFAULT 'auto' CHECK (approval_policy IN ('auto', 'manual')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  blocked boolean NOT NULL DEFAULT false,
  block_reason text,
  internal_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buyer_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  title text NOT NULL,
  file_id uuid REFERENCES files(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  note text,
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buyer_documents_user_idx ON buyer_documents(user_id, created_at DESC);
