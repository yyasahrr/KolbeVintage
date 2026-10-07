-- Retail cashback wallet (loyalty credit — NEVER withdrawable, NEVER transferable).
-- Completely separate from the supplier wallet (005_wallet.sql): that one settles real money,
-- this one is store credit earned from retail purchases and spendable only at checkout.
--
-- Design: pure double-entry style ledger. Every row moves a signed amount inside ONE bucket
-- ('pending' or 'available'); balances are plain SUM(amount_rial) per bucket. A release moves
-- value with a −pending row plus a +available row sharing the same earn reference. All writes
-- carry an idempotency key, so earn/release/reverse/expire/redeem/restore can be retried safely.

CREATE TABLE cashback_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100,
  starts_at timestamptz,
  ends_at timestamptz,
  -- exactly one of percent / fixed_rial
  percent int CHECK (percent IS NULL OR (percent >= 1 AND percent <= 100)),
  fixed_rial numeric(18,0) CHECK (fixed_rial IS NULL OR fixed_rial > 0),
  min_order_rial numeric(18,0) NOT NULL DEFAULT 0,
  max_per_order_rial numeric(18,0) CHECK (max_per_order_rial IS NULL OR max_per_order_rial > 0),
  min_quantity int CHECK (min_quantity IS NULL OR min_quantity >= 1),
  first_order_only boolean NOT NULL DEFAULT false,
  max_uses_per_customer int CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer >= 1),
  -- which payment modes earn cashback (conservative default: cash only)
  payment_modes text[] NOT NULL DEFAULT ARRAY['cash'],
  -- {"vipOnly": bool} — kept as jsonb for forward-compatible segment scoping
  customer_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {"includeCategories":[],"excludeCategories":[],"includeProductIds":[],"excludeProductIds":[]}
  product_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  release_delay_days int NOT NULL DEFAULT 7 CHECK (release_delay_days >= 0),
  expiration_days int CHECK (expiration_days IS NULL OR expiration_days >= 1),
  stacking text NOT NULL DEFAULT 'exclusive' CHECK (stacking IN ('exclusive','stack')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((percent IS NULL) <> (fixed_rial IS NULL))
);
CREATE INDEX cashback_rules_active_idx ON cashback_rules(active, priority);

CREATE TABLE cashback_transactions (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES users(id),
  tx_type text NOT NULL CHECK (tx_type IN (
    'cashback_pending',   -- earn on paid retail order (+ in pending)
    'cashback_released',  -- move pending → available after delivery + delay (−pending / +available pair)
    'cashback_redeemed',  -- spent at checkout (− in available)
    'cashback_reversed',  -- order cancelled / refunded before or after release (− in its bucket)
    'cashback_expired',   -- unused released credit past expiry (− in available)
    'refund_restore',     -- redeemed credit given back after a refund (+ in available)
    'admin_credit',       -- manual, audited (+ in available)
    'admin_debit'         -- manual, audited (− in available)
  )),
  bucket text NOT NULL CHECK (bucket IN ('pending','available')),
  amount_rial numeric(18,0) NOT NULL CHECK (amount_rial <> 0),
  source text NOT NULL DEFAULT 'order' CHECK (source IN ('order','rule','admin','refund','expiry','release')),
  source_order_id uuid REFERENCES orders(id),
  source_rule_id uuid REFERENCES cashback_rules(id),
  related_tx_id uuid REFERENCES cashback_transactions(id),
  description text,
  actor_id uuid REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- on the earn row: when the credit becomes usable / when it dies (set at delivery time)
  available_at timestamptz,
  expires_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cashback_tx_customer_idx ON cashback_transactions(customer_id, created_at DESC);
CREATE INDEX cashback_tx_order_idx ON cashback_transactions(source_order_id) WHERE source_order_id IS NOT NULL;
CREATE INDEX cashback_tx_release_idx ON cashback_transactions(tx_type, available_at) WHERE tx_type = 'cashback_pending';
CREATE INDEX cashback_tx_expiry_idx ON cashback_transactions(tx_type, expires_at) WHERE tx_type = 'cashback_pending';

-- Ledger rows are immutable except for the release/expiry scheduling columns on the earn row
-- (available_at / expires_at are stamped once at delivery). Enforced in application code inside
-- serialized per-customer transactions; a DB trigger stays out so the lazy scheduler can stamp them.

-- Wallet redemption recorded on the order itself (additive column, default 0 keeps old rows valid).
ALTER TABLE orders ADD COLUMN cashback_redeemed_rial numeric(18,0) NOT NULL DEFAULT 0;

-- RBAC (reuses the existing permission tables).
INSERT INTO permissions(code, title) VALUES
  ('cashback:read', 'مشاهده کیف پول کش‌بک'),
  ('cashback:rules_manage', 'مدیریت قوانین کش‌بک'),
  ('cashback:adjust', 'اصلاح دستی کیف پول کش‌بک')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'cashback:read'), ('admin', 'cashback:rules_manage'), ('admin', 'cashback:adjust'),
  ('finance', 'cashback:read'), ('support', 'cashback:read')
ON CONFLICT DO NOTHING;

-- Conservative default redemption policy (admin-editable in site_settings).
INSERT INTO site_settings(key, value) VALUES ('cashback_policy', '{
  "redemptionEnabled": true,
  "maxPercentOfOrder": 50,
  "minRedeemRial": "100000",
  "earnOnInstallments": false,
  "redeemOnInstallments": false
}'::jsonb)
ON CONFLICT (key) DO NOTHING;
