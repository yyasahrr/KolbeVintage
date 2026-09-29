-- 022: CRM ↔ promotion safety, personal coupons and coupon campaign templates (items 136-143).
-- The coupon engine itself lives in 008/`coupons.ts`; this migration adds the
-- guards that make automated promotion safe (run caps, cooldowns, budgets,
-- dry-run/approval state) plus reusable campaign templates.

-- ---------------------------------------------------------------------------
-- Personal / templated coupons
-- ---------------------------------------------------------------------------
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS template_code text,
  ADD COLUMN IF NOT EXISTS installment_policy text
    CHECK (installment_policy IS NULL OR installment_policy IN ('inherit', 'cash_only', 'installment_only', 'no_interest')),
  ADD COLUMN IF NOT EXISTS generation_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS issued_by_rule_id uuid;

COMMENT ON COLUMN coupons.generation_meta IS 'How the instance was produced: rule, trigger event, batch id and audience snapshot.';
COMMENT ON COLUMN coupons.installment_policy IS 'installment restriction carried by the personal coupon (item 140).';

CREATE INDEX IF NOT EXISTS coupons_recipient_idx ON coupons(recipient_user_id) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coupons_template_idx ON coupons(template_code);

CREATE TABLE IF NOT EXISTS coupon_campaign_templates (
  code text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('percent', 'fixed')),
  value bigint NOT NULL CHECK (value > 0),
  max_discount_rial bigint CHECK (max_discount_rial IS NULL OR max_discount_rial > 0),
  min_order_rial bigint NOT NULL DEFAULT 0 CHECK (min_order_rial >= 0),
  usage_limit_per_user integer NOT NULL DEFAULT 1 CHECK (usage_limit_per_user > 0),
  usage_limit_total integer CHECK (usage_limit_total IS NULL OR usage_limit_total > 0),
  validity_days integer NOT NULL DEFAULT 14 CHECK (validity_days BETWEEN 1 AND 365),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience text[] NOT NULL DEFAULT '{}',
  installment_policy text NOT NULL DEFAULT 'inherit',
  code_prefix text NOT NULL DEFAULT 'KV',
  message_template text NOT NULL DEFAULT '{name} عزیز، کد تخفیف اختصاصی شما: {code}',
  trigger_code text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'percent' OR value <= 100)
);

CREATE INDEX IF NOT EXISTS coupon_campaign_templates_trigger_idx ON coupon_campaign_templates(trigger_code);

-- ---------------------------------------------------------------------------
-- CRM trigger catalog (requirement 142) — the vocabulary automations subscribe to
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_trigger_catalog (
  code text PRIMARY KEY,
  title text NOT NULL,
  event_type text NOT NULL,
  category text NOT NULL CHECK (category IN ('purchase', 'lifecycle', 'membership', 'cart', 'review', 'support', 'custom')),
  description text NOT NULL DEFAULT '',
  default_action text NOT NULL DEFAULT 'label',
  default_channel text NOT NULL DEFAULT 'sms',
  cooldown_hours integer NOT NULL DEFAULT 24 CHECK (cooldown_hours >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO crm_trigger_catalog (code, title, event_type, category, description, default_action, default_channel, cooldown_hours) VALUES
  ('spend_threshold', 'گذر از سقف خرید', 'order.paid', 'purchase', 'مجموع خرید مشتری از یک سقف مشخص عبور کند.', 'label', 'sms', 168),
  ('first_order', 'اولین خرید', 'order.paid', 'purchase', 'مشتری اولین سفارش خود را ثبت و پرداخت کند.', 'sms', 'sms', 0),
  ('fifth_order', 'پنجمین خرید', 'order.paid', 'purchase', 'مشتری به پنجمین سفارش پرداخت‌شده برسد.', 'coupon', 'sms', 0),
  ('inactivity_60d', '۶۰ روز بی‌فعالیتی', 'customer.inactivity', 'lifecycle', '۶۰ روز از آخرین خرید مشتری گذشته باشد.', 'coupon', 'sms', 720),
  ('membership_expiry', 'نزدیک شدن انقضای عضویت', 'membership.expiring', 'membership', 'کمتر از ۷ روز به پایان عضویت باقی مانده باشد.', 'sms', 'sms', 168),
  ('membership_activated', 'فعال‌سازی عضویت', 'membership.activated', 'membership', 'پرداخت تأییدشده عضویت را فعال کرده باشد.', 'notification', 'sms', 0),
  ('vip_upgrade', 'ارتقا به VIP', 'membership.upgraded', 'membership', 'مشتری به پلن VIP ارتقا پیدا کند.', 'label', 'sms', 0),
  ('cart_abandoned', 'سبد خرید رهاشده', 'cart.abandoned', 'cart', 'سبد خرید بدون پرداخت رها شود.', 'sms', 'sms', 48),
  ('wishlist_restock', 'شارژ مجدد علاقه‌مندی', 'inventory.restocked', 'cart', 'کالای موجود در علاقه‌مندی‌ها دوباره موجود شود.', 'notification', 'sms', 24),
  ('review_high_rating', 'نظر مثبت', 'review.created', 'review', 'نظر ۴ یا ۵ ستاره ثبت شود.', 'note', 'sms', 0),
  ('review_low_rating', 'نظر منفی', 'review.created', 'review', 'نظر ۱ یا ۲ ستاره ثبت شود (پیگیری پشتیبانی).', 'ticket', 'none', 0),
  ('order_returned', 'مرجوعی سفارش', 'order.returned', 'support', 'سفارش مشتری مرجوع شود.', 'label', 'sms', 168),
  ('failed_payment', 'پرداخت ناموفق', 'payment.failed', 'purchase', 'پرداخت مشتری ناموفق باشد.', 'sms', 'sms', 24),
  ('birthday', 'تولد مشتری', 'customer.birthday', 'lifecycle', 'روز تولد مشتری فرارسیده باشد (کد تخفیف شخصی).', 'coupon', 'sms', 8760),
  ('search_no_result', 'جست‌وجوی بی‌نتیجه', 'search.no_result', 'custom', 'مشتری برای کالای ناموجود جست‌وجو کرده باشد.', 'notification', 'sms', 72),
  ('custom_webhook', 'رویداد سفارشی (n8n)', 'custom.*', 'custom', 'هر رویداد سفارشی که از n8n یا سیستم داخلی برسد.', 'webhook', 'none', 0),
  ('customer_created', 'ثبت‌نام مشتری', 'customer.created', 'lifecycle', 'حساب کاربری جدید ساخته شود.', 'notification', 'sms', 0),
  ('tier_downgrade', 'تنزل پلن', 'membership.downgraded', 'membership', 'پلن عضویت در پایان دوره تنزل یابد.', 'note', 'none', 0)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Automation safety guards (requirement 137) on the legacy automations table
-- ---------------------------------------------------------------------------
ALTER TABLE crm_automations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'test', 'active', 'paused', 'archived')),
  ADD COLUMN IF NOT EXISTS trigger_code text,
  ADD COLUMN IF NOT EXISTS target_kind text CHECK (target_kind IS NULL OR target_kind IN ('label', 'segment', 'customer')),
  ADD COLUMN IF NOT EXISTS target_ref text,
  ADD COLUMN IF NOT EXISTS daily_run_cap integer CHECK (daily_run_cap IS NULL OR daily_run_cap > 0),
  ADD COLUMN IF NOT EXISTS audience_cap integer CHECK (audience_cap IS NULL OR audience_cap > 0),
  ADD COLUMN IF NOT EXISTS cooldown_hours integer NOT NULL DEFAULT 24 CHECK (cooldown_hours >= 0),
  ADD COLUMN IF NOT EXISTS budget_cap_rial bigint CHECK (budget_cap_rial IS NULL OR budget_cap_rial > 0),
  ADD COLUMN IF NOT EXISTS budget_spent_rial bigint NOT NULL DEFAULT 0 CHECK (budget_spent_rial >= 0),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dry_run_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS manual_approval_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS runs_today integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS runs_today_date date,
  ADD COLUMN IF NOT EXISTS last_dry_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_dry_run_match_count integer,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS coupon_template_code text;

COMMENT ON COLUMN crm_automations.status IS 'draft → test → active ⇄ paused (requirement 137); archived keeps history.';

ALTER TABLE crm_automation_runs
  ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS matched_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_spent_rial bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS triggered_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS trigger_type text,
  ADD COLUMN IF NOT EXISTS note text;

-- Personal coupon batches are traced back to the run that produced them.
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS issued_run_id uuid;

-- One personal coupon per (template, customer, run) so a trigger run can never
-- mint duplicates (requirement 140: unique + auditable). "One per day" is enforced
-- in application code because a time-zone dependent expression cannot be indexed.
CREATE UNIQUE INDEX IF NOT EXISTS coupons_personal_run_uidx
  ON coupons(recipient_user_id, template_code, issued_run_id)
  WHERE recipient_user_id IS NOT NULL AND template_code IS NOT NULL AND issued_run_id IS NOT NULL;

-- Prevent two active automations from firing the same trigger at the same target.
CREATE UNIQUE INDEX IF NOT EXISTS crm_automations_active_trigger_uidx
  ON crm_automations(trigger_code, COALESCE(target_kind, ''), COALESCE(target_ref, ''))
  WHERE status = 'active' AND trigger_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Permissions for the promotion-safety surface
-- ---------------------------------------------------------------------------
INSERT INTO permissions(code, title) VALUES
  ('promo:safety', 'امنیت پروموشن — سقف اجرا، تست خشک و تأیید'),
  ('promo:templates', 'قالب کمپین کوپن و صدور کوپن شخصی')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'promo:safety'), ('admin', 'promo:templates'),
  ('finance', 'promo:safety'), ('support', 'promo:templates')
ON CONFLICT DO NOTHING;
