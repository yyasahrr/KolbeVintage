-- =========================================================================
-- merged from 017_crm_intelligence.sql when this branch's migrations moved to the 045-049 slot
-- =========================================================================
-- Requirements 20-21 + 95-104 + 108 + 136-143: the CRM intelligence layer.
-- Smart/behavioral labels, a server-side rule engine, dynamic segments, the
-- customer activity timeline, internal notes, marketing consent and the
-- account-security/profile-verification state. Customer data stays canonical:
-- every table here keys on users.id and never duplicates the profile itself.

CREATE TABLE IF NOT EXISTS crm_labels (
  code text PRIMARY KEY,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'behavioral' CHECK (kind IN ('manual', 'behavioral')),
  description text NOT NULL DEFAULT '',
  color text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_contact_labels (
  contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  label_code text NOT NULL REFERENCES crm_labels(code) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'rule', 'automation', 'import')),
  rule_id uuid,
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (contact_id, label_code)
);
CREATE INDEX IF NOT EXISTS crm_contact_labels_code_idx ON crm_contact_labels(label_code);

-- Label rules: conditions are evaluated server-side against canonical customer data.
CREATE TABLE IF NOT EXISTS crm_label_rules (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  label_code text NOT NULL REFERENCES crm_labels(code) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'test', 'active', 'paused')),
  match_mode text NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_days integer CHECK (window_days IS NULL OR window_days > 0),
  priority integer NOT NULL DEFAULT 100,
  requires_approval boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  last_run_at timestamptz,
  last_match_count integer,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_label_rules_status_idx ON crm_label_rules(status, priority);

CREATE TABLE IF NOT EXISTS crm_segments (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'dynamic' CHECK (kind IN ('dynamic', 'manual')),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  refresh_interval_minutes integer CHECK (refresh_interval_minutes IS NULL OR refresh_interval_minutes > 0),
  last_refreshed_at timestamptz,
  member_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_segment_members (
  segment_id uuid NOT NULL REFERENCES crm_segments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matched_at timestamptz NOT NULL DEFAULT now(),
  matched_by text NOT NULL DEFAULT 'rule',
  PRIMARY KEY (segment_id, user_id)
);
CREATE INDEX IF NOT EXISTS crm_segment_members_user_idx ON crm_segment_members(user_id);

-- Internal notes (requirement 100): never visible to the customer, always attributed.
CREATE TABLE IF NOT EXISTS crm_notes (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'team')),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_notes_contact_idx ON crm_notes(contact_id, created_at DESC);

-- Canonical customer activity timeline (requirement 99) for customer 360 (95).
CREATE TABLE IF NOT EXISTS customer_timeline (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  ref_type text,
  ref_id text,
  actor_id uuid REFERENCES users(id),
  source text NOT NULL DEFAULT 'system',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_timeline_user_idx ON customer_timeline(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS customer_timeline_type_idx ON customer_timeline(event_type, occurred_at DESC);

-- Marketing vs transactional consent (requirement 143): transactional tracking SMS
-- and marketing campaigns are separate decisions and both are auditable.
CREATE TABLE IF NOT EXISTS customer_consents (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  marketing_sms boolean NOT NULL DEFAULT false,
  transactional_sms boolean NOT NULL DEFAULT true,
  email_marketing boolean NOT NULL DEFAULT false,
  do_not_contact boolean NOT NULL DEFAULT false,
  unsubscribed_at timestamptz,
  source text NOT NULL DEFAULT 'default',
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customer_consents IS 'Marketing consent gate for every SMS campaign (item 143).';

-- Self-service + admin profile editing with verification (requirement 103).
CREATE TABLE IF NOT EXISTS customer_contact_changes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'phone')),
  new_value text NOT NULL,
  code_hash char(64) NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email_link', 'sms_otp')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_contact_changes_user_idx ON customer_contact_changes(user_id, created_at DESC);

-- Login history + active sessions + two-factor design (requirement 104).
CREATE TABLE IF NOT EXISTS user_login_history (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  identity text NOT NULL DEFAULT '',
  success boolean NOT NULL,
  reason text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_login_history_user_idx ON user_login_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method text CHECK (method IN ('otp_sms', 'authenticator')),
  enabled boolean NOT NULL DEFAULT false,
  secret_ciphertext bytea,
  secret_iv bytea,
  secret_tag bytea,
  secret_hint text,
  recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name text,
  last_name text,
  gender text CHECK (gender IN ('female', 'male', 'unspecified')),
  national_id text,
  avatar_file_id uuid REFERENCES files(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seeds for the label catalogue (requirement 20/97). Rules are created by admins;
-- the labels themselves are part of the product definition.
INSERT INTO crm_labels(code, title, kind, description) VALUES
  ('new_customer', 'مشتری جدید', 'behavioral', 'ثبت‌نام کمتر از ۳۰ روز پیش و بدون خرید'),
  ('loyal_customer', 'مشتری وفادار', 'behavioral', 'حداقل ۵ سفارش پرداخت‌شده'),
  ('vip', 'VIP', 'behavioral', 'عضویت VIP فعال'),
  ('wholesale_buyer', 'خریدار عمده', 'behavioral', 'عضویت عمده فعال'),
  ('high_spender', 'پرخرج', 'behavioral', 'مجموع خرید بالای آستانه تعریف‌شده'),
  ('at_risk', 'در معرض ریزش', 'behavioral', 'بیش از ۶۰ روز بدون خرید'),
  ('churned', 'ریزش‌یافته', 'behavioral', 'بیش از ۱۲۰ روز بدون خرید'),
  ('inactive', 'کم‌فعال', 'behavioral', 'فعالیت کم در ۹۰ روز گذشته'),
  ('repeat_buyer', 'خریدار تکراری', 'behavioral', 'حداقل ۲ سفارش پرداخت‌شده'),
  ('abandoned_cart', 'سبد رهاشده', 'behavioral', 'سبد فعال بدون تکمیل خرید'),
  ('failed_payment', 'پرداخت ناموفق', 'behavioral', 'پرداخت ناموفق ثبت‌شده'),
  ('membership_expiring', 'عضویت رو به انقضا', 'behavioral', 'انقضای عضویت تا ۷ روز آینده'),
  ('plan_upgraded', 'Plan ارتقایافته', 'behavioral', 'ارتقای پلن در ۹۰ روز گذشته'),
  ('high_return', 'مرجوعی بالا', 'behavioral', 'نسبت مرجوعی بالای ۳۰٪'),
  ('discount_driven', 'خریدار تخفیف‌محور', 'behavioral', 'بیشتر خریدها با کد تخفیف انجام شده'),
  ('installment_buyer', 'خریدار اقساطی', 'behavioral', 'خرید اقساطی داشته است')
ON CONFLICT (code) DO NOTHING;

