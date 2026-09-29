-- 023: remaining gaps for items 15-24 / 101-104 / 136-143.
--   1. SMS-OTP two-factor login challenges (item 104: OTP + authenticator design).
--   2. Server-side cart so "cart.abandoned" is a real, automatable event (items 23/142).
--   3. The automation type vocabulary of the legacy automations table grows with the
--      behavioural triggers the CRM now supports.

-- ---------------------------------------------------------------------------
-- Two-factor: one-time codes for login / sensitive steps (item 104)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS two_factor_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'sensitive_action')),
  method text NOT NULL DEFAULT 'otp_sms' CHECK (method IN ('otp_sms', 'recovery_code')),
  code_hash text NOT NULL,
  phone text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS two_factor_challenges_user_idx
  ON two_factor_challenges(user_id, purpose) WHERE consumed_at IS NULL;
COMMENT ON TABLE two_factor_challenges IS 'Server-side OTP challenges; the code is only ever stored hashed.';

-- ---------------------------------------------------------------------------
-- Server-side cart (requirement 23: cart.abandoned must be a real event)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  session_key text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'abandoned', 'expired')),
  value_rial bigint NOT NULL DEFAULT 0 CHECK (value_rial >= 0),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  currency text NOT NULL DEFAULT 'IRR',
  abandoned_at timestamptz,
  notified_at timestamptz,
  converted_order_id uuid REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR session_key IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS carts_user_active_uidx ON carts(user_id) WHERE user_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS carts_session_active_uidx ON carts(session_key) WHERE session_key IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS carts_abandoned_idx ON carts(status, updated_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cart_items (
  id uuid PRIMARY KEY,
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_rial bigint NOT NULL CHECK (unit_price_rial >= 0),
  color_label text,
  size_label text,
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cart_items_cart_idx ON cart_items(cart_id);
-- Postgres rejects expressions inside a UNIQUE table constraint, so the "same product
-- in the same colour/size" rule is a unique index instead.
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_unique_line_uidx
  ON cart_items(cart_id, product_id, COALESCE(color_label, ''), COALESCE(size_label, ''));

-- ---------------------------------------------------------------------------
-- Automation vocabulary: behavioural triggers are first-class automation types now
-- ---------------------------------------------------------------------------
ALTER TABLE crm_automations DROP CONSTRAINT IF EXISTS crm_automations_automation_type_check;
ALTER TABLE crm_automations ADD CONSTRAINT crm_automations_automation_type_check
  CHECK (automation_type IN (
    'birthday_sms', 'winback', 'order_followup', 'restock_alert', 'price_drop',
    'trigger_rule', 'cart_abandoned', 'first_order', 'fifth_order', 'spend_threshold',
    'inactivity', 'membership_expiry', 'vip_upgrade', 'review_followup', 'custom_webhook'
  ));

-- Cart activity is now part of the CRM timeline vocabulary.
ALTER TABLE crm_activities DROP CONSTRAINT IF EXISTS crm_activities_type_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_type_check
  CHECK (type IN ('note', 'call', 'sms', 'email', 'automation', 'order', 'ticket', 'coupon', 'event', 'cart'));

-- Automation runs also record which trigger/target produced them for the run log.
ALTER TABLE crm_automation_runs
  ADD COLUMN IF NOT EXISTS trigger_code text,
  ADD COLUMN IF NOT EXISTS target_ref text;

-- ---------------------------------------------------------------------------
-- Permissions for the surfaces added by this pass
-- ---------------------------------------------------------------------------
INSERT INTO permissions(code, title) VALUES
  ('security:manage', 'مرکز امنیت حساب — نشست‌ها، ورود دومرحله‌ای و تاریخچه ورود')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'security:manage'), ('support', 'security:manage')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Event catalog completeness: the events emitted by the growth features must be
-- visible/documented in the automation center (item 87).
-- ---------------------------------------------------------------------------
INSERT INTO automation_event_catalog(event_type, title, domain, description, payload_example) VALUES
  ('customer.2fa_challenge', 'چالش ورود دومرحله‌ای', 'security', 'کد یک‌بارمصرف ورود ارسال شد.', '{"challengeId":"uuid","purpose":"login"}'),
  ('cart.converted', 'تبدیل سبد به سفارش', 'cart', 'سبد خرید به سفارش تبدیل شد.', '{"cartId":"uuid","orderId":"uuid"}'),
  ('cart.nudged', 'یادآوری سبد خرید', 'cart', 'یادآوری سبد رهاشده ارسال شد.', '{"cartId":"uuid","valueRial":"1000000"}'),
  ('buyer.blocked', 'مسدودسازی خریدار', 'crm', 'حساب خریدار عمده مسدود شد.', '{"userId":"uuid","reason":"…"}'),
  ('buyer.unblocked', 'رفع مسدودی خریدار', 'crm', 'مسدودیت حساب خریدار برداشته شد.', '{"userId":"uuid"}'),
  ('crm.campaign.targeted', 'کمپین هدفمند CRM', 'crm', 'کمپین بر پایه سگمنت/برچسب ساخته شد.', '{"campaignId":"uuid","recipients":120}'),
  ('crm.campaign_sms', 'ارسال پیامک کمپین', 'crm', 'پیامک کمپین برای یک مشتری صف شد.', '{"campaignId":"uuid","userId":"uuid"}'),
  ('crm.automation_message', 'پیام اتوماسیون CRM', 'crm', 'اتوماسیون برای یک مشتری پیام فرستاد.', '{"automationId":"uuid","userId":"uuid"}'),
  ('coupon.personal_issued', 'صدور کوپن شخصی', 'promotion', 'کوپن اختصاصی برای مشتری ساخته شد.', '{"couponId":"uuid","template":"birthday"}'),
  ('membership.renewed', 'تمدید عضویت', 'membership', 'عضویت عمده تمدید شد.', '{"membershipId":"uuid","userId":"uuid"}'),
  ('membership.upgraded', 'ارتقای عضویت', 'membership', 'پلن عضویت ارتقا یافت.', '{"membershipId":"uuid","toPlanId":"uuid"}'),
  ('membership.downgraded', 'تنزل عضویت', 'membership', 'پلن عضویت تنزل یافت.', '{"membershipId":"uuid","toPlanId":"uuid"}'),
  ('membership.cancelled', 'لغو عضویت', 'membership', 'عضویت لغو شد.', '{"membershipId":"uuid"}'),
  ('customer.contact_change', 'تغییر راه ارتباطی', 'security', 'درخواست تغییر ایمیل/همراه ثبت شد.', '{"requestId":"uuid","kind":"phone"}'),
  ('customer.profile_updated', 'به‌روزرسانی پروفایل', 'crm', 'مشتری پروفایل خود را ویرایش کرد.', '{"userId":"uuid","fields":["city"]}'),
  ('recommendation.clicked', 'کلیک روی پیشنهاد', 'recommendation', 'کاربر روی پیشنهاد کلیک کرد.', '{"slot":"home.for_you","productId":"uuid"}'),
  ('video.progress', 'پیشرفت تماشای ویدیو', 'media', 'کاربر درصدی از ویدیو را دید.', '{"videoId":"uuid","percent":50}'),
  ('review.reported', 'گزارش نظر', 'reviews', 'یک نظر توسط کاربر گزارش شد.', '{"reviewId":"uuid","reason":"spam"}')
ON CONFLICT (event_type) DO NOTHING;
