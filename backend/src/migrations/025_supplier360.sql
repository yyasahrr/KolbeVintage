-- 025 — Supplier 360 (items 11-14)
--
-- Owner: agent B — Supplier 360 / finance branch (reserved range 025-034).
-- Runs after 024; depends only on canonical tables from the shared base
-- (001_core: users, supplier_profiles) and adds no parallel domain.
--
-- Scope: activity statuses with reason/actor/duration, supplier_status_history,
-- and granular supplier_restrictions that are enforced server-side.

-- ---------------------------------------------------------------- item 11 --
-- Supplier activity status is a real, managed lifecycle (not just a boolean).
ALTER TABLE supplier_profiles ADD COLUMN activity_status text NOT NULL DEFAULT 'pending_review'
  CHECK (activity_status IN ('pending_review', 'active', 'restricted', 'suspended', 'blocked', 'rejected'));
ALTER TABLE supplier_profiles ADD COLUMN activity_reason text;
ALTER TABLE supplier_profiles ADD COLUMN activity_note text;
ALTER TABLE supplier_profiles ADD COLUMN activity_restricted_until timestamptz;
ALTER TABLE supplier_profiles ADD COLUMN activity_changed_at timestamptz;
ALTER TABLE supplier_profiles ADD COLUMN activity_changed_by uuid REFERENCES users(id);

-- The legacy cooperation status (pending/approved/suspended/rejected) and the
-- richer activity lifecycle (6 states) stay in sync automatically, so profiles
-- created through older flows are usable and enforcement never misfires.
CREATE FUNCTION sync_supplier_activity_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.activity_status := CASE NEW.cooperation_status
      WHEN 'approved' THEN 'active' WHEN 'pending' THEN 'pending_review'
      WHEN 'suspended' THEN 'suspended' WHEN 'rejected' THEN 'rejected'
      ELSE NEW.activity_status END;
  ELSIF NEW.cooperation_status IS DISTINCT FROM OLD.cooperation_status
        AND NEW.activity_status = OLD.activity_status THEN
    NEW.activity_status := CASE NEW.cooperation_status
      WHEN 'approved' THEN 'active' WHEN 'pending' THEN 'pending_review'
      WHEN 'suspended' THEN 'suspended' WHEN 'rejected' THEN 'rejected'
      ELSE NEW.activity_status END;
    NEW.activity_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_activity_status_sync BEFORE INSERT OR UPDATE ON supplier_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_supplier_activity_status();

UPDATE supplier_profiles SET activity_status = CASE cooperation_status
  WHEN 'approved' THEN 'active' WHEN 'pending' THEN 'pending_review'
  WHEN 'suspended' THEN 'suspended' WHEN 'rejected' THEN 'rejected'
  ELSE activity_status END;

CREATE TABLE supplier_status_history (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  note text,
  restricted_until timestamptz,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_status_history_user_idx ON supplier_status_history(user_id, created_at DESC);

-- Granular restrictions: every scope is enforced server-side, never only in the UI.
CREATE TABLE supplier_restrictions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK (scope IN ('product_create', 'product_edit', 'product_publish',
    'order_intake', 'withdrawal', 'settlement_request', 'product_limit', 'sales_limit', 'feature')),
  feature_code text,
  limit_value bigint CHECK (limit_value IS NULL OR limit_value >= 0),
  reason text NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted', 'expired')),
  expires_at timestamptz,
  created_by uuid REFERENCES users(id),
  lifted_by uuid REFERENCES users(id),
  lifted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_restrictions_active_idx ON supplier_restrictions(user_id, scope)
  WHERE status = 'active';
