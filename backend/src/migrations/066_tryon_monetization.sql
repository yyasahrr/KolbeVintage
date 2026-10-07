-- ============================================================================
-- 066 — Try-On monetization (Prompt 4 §42-§47, §199)
-- Paid virtual try-on service: configurable packages, credit ledger, purchases
-- through the ONE canonical payment pipeline. Costs are stored only when a real
-- provider cost is known (NULL = honest unknown, never fabricated).
-- Additive only; 063/064/065 untouched.
-- ============================================================================

CREATE TABLE tryon_packages (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  price_rial bigint NOT NULL CHECK (price_rial >= 0),
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  expiry_days integer CHECK (expiry_days IS NULL OR expiry_days > 0),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Balance projection (ledger below is the truth); row lock = concurrency guard.
CREATE TABLE tryon_credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  free_granted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tryon_credit_purchases (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  package_id uuid NOT NULL REFERENCES tryon_packages(id),
  package_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  credits integer NOT NULL CHECK (credits > 0),
  price_rial bigint NOT NULL CHECK (price_rial > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  payment_intent_id uuid REFERENCES payment_intents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX tryon_credit_purchases_user_idx ON tryon_credit_purchases(user_id, created_at DESC);
CREATE INDEX tryon_credit_purchases_status_idx ON tryon_credit_purchases(status, created_at DESC);
CREATE UNIQUE INDEX tryon_credit_purchases_intent_uniq ON tryon_credit_purchases(payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- Append-only credit ledger; balance_after >= 0 ⇒ no negative credits ever (§221).
CREATE TABLE tryon_credit_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  qty integer NOT NULL CHECK (qty > 0),
  reason text NOT NULL CHECK (reason IN ('free_quota', 'purchase', 'generation', 'refund', 'admin_adjust')),
  purchase_id uuid REFERENCES tryon_credit_purchases(id),
  job_ref text,
  -- §45/§46: real provider cost per generation when available; NULL = unknown/not connected.
  generation_cost_rial bigint CHECK (generation_cost_rial IS NULL OR generation_cost_rial >= 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tryon_credit_ledger_user_idx ON tryon_credit_ledger(user_id, created_at DESC);

-- Canonical payment linkage: a try-on purchase is one more intent purpose —
-- same pipeline, same replay guards, no second payment system.
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS tryon_purchase_id uuid REFERENCES tryon_credit_purchases(id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_tryon_uniq ON payment_intents(tryon_purchase_id)
  WHERE tryon_purchase_id IS NOT NULL;
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'payment_intents'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%purpose%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE payment_intents DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_purpose_check
  CHECK (purpose IN ('order', 'membership', 'child_order', 'child_batch', 'tryon'));

-- Business config (admin-editable, not hardcoded): free quota + sales switch.
INSERT INTO site_settings(key, value) VALUES
  ('tryon_policy', '{"freeQuota": 1, "salesEnabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Conceptual default package (§43): 5 generations / 100,000 Toman — editable business value.
INSERT INTO tryon_packages(id, name, credits, price_rial, active, sort)
VALUES ('00000000-0000-4000-9000-000000000021', 'بسته ۵ پرو مجازی', 5, 1000000, true, 1)
ON CONFLICT (id) DO NOTHING;
