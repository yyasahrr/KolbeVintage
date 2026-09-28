-- Coupons and festivals with full targeting rules (item 17).
CREATE TABLE festivals (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  occasion text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  daily_start_time time,
  daily_end_time time,
  audience text[] NOT NULL DEFAULT '{}',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  min_order_rial bigint NOT NULL DEFAULT 0 CHECK (min_order_rial >= 0),
  max_discount_rial bigint CHECK (max_discount_rial IS NULL OR max_discount_rial > 0),
  discount_percent numeric(5,2) CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100)),
  discount_fixed_rial bigint CHECK (discount_fixed_rial IS NULL OR discount_fixed_rial > 0),
  usage_limit_total integer CHECK (usage_limit_total IS NULL OR usage_limit_total > 0),
  usage_limit_per_user integer CHECK (usage_limit_per_user IS NULL OR usage_limit_per_user > 0),
  auto_apply boolean NOT NULL DEFAULT false,
  theme_palette_code text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_percent IS NOT NULL OR discount_fixed_rial IS NOT NULL),
  CHECK (ends_at > starts_at)
);
CREATE INDEX festivals_active_idx ON festivals(starts_at, ends_at) WHERE active;

CREATE TABLE coupons (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  festival_id uuid REFERENCES festivals(id),
  campaign_name text,
  type text NOT NULL CHECK (type IN ('percent', 'fixed')),
  value bigint NOT NULL CHECK (value > 0),
  max_discount_rial bigint CHECK (max_discount_rial IS NULL OR max_discount_rial > 0),
  min_order_rial bigint NOT NULL DEFAULT 0 CHECK (min_order_rial >= 0),
  usage_limit_total integer CHECK (usage_limit_total IS NULL OR usage_limit_total > 0),
  usage_limit_per_user integer CHECK (usage_limit_per_user IS NULL OR usage_limit_per_user > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  recipient_user_id uuid REFERENCES users(id),
  audience text[] NOT NULL DEFAULT '{}',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  daily_start_time time,
  daily_end_time time,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'festival', 'crm_automation', 'campaign')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'percent' OR value <= 100),
  CHECK (ends_at > starts_at)
);
CREATE INDEX coupons_recipient_idx ON coupons(recipient_user_id) WHERE recipient_user_id IS NOT NULL;

CREATE TABLE coupon_redemptions (
  id uuid PRIMARY KEY,
  coupon_id uuid NOT NULL REFERENCES coupons(id),
  user_id uuid NOT NULL REFERENCES users(id),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  discount_rial bigint NOT NULL CHECK (discount_rial > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, order_id)
);
CREATE INDEX coupon_redemptions_user_idx ON coupon_redemptions(user_id, created_at DESC);
CREATE TRIGGER coupon_redemptions_immutable BEFORE UPDATE OR DELETE ON coupon_redemptions
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

-- CRM over every actor type (item 16).
CREATE TABLE crm_contacts (
  id uuid PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES users(id),
  actor_type text NOT NULL DEFAULT 'customer' CHECK (actor_type IN ('customer', 'vip', 'wholesale_buyer',
    'supplier', 'partner', 'other')),
  segment text,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_contacts_actor_idx ON crm_contacts(actor_type, updated_at DESC);

CREATE TABLE crm_activities (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('note', 'call', 'sms', 'email', 'automation', 'order', 'ticket', 'coupon', 'event')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  ref_type text,
  ref_id text,
  result jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_activities_contact_idx ON crm_activities(contact_id, created_at DESC);

CREATE TABLE crm_automations (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  automation_type text NOT NULL CHECK (automation_type IN ('birthday_sms', 'winback', 'order_followup',
    'restock_alert', 'price_drop')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_automation_runs (
  id uuid PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES crm_automations(id),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  processed_count integer NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

INSERT INTO permissions(code, title) VALUES
  ('promos:manage', 'مدیریت کوپن و جشنواره')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'promos:manage'), ('admin', 'crm:manage')
ON CONFLICT DO NOTHING;
