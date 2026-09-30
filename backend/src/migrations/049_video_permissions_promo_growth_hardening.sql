-- =========================================================================
-- merged from 020_video_analytics.sql when this branch's migrations moved to the 045-049 slot
-- =========================================================================
-- Requirements 313-314: responsive product video data (poster + adaptive sources,
-- served from the media domain, never from backend memory) and the video analytics
-- event stream that CRM/Analytics can consume.

CREATE TABLE IF NOT EXISTS product_media (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'gallery' CHECK (role IN ('gallery', 'flat_lay', 'video', 'poster', 'size_guide', 'campaign')),
  file_id uuid REFERENCES files(id),
  external_url text,
  poster_file_id uuid REFERENCES files(id),
  position integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (file_id IS NOT NULL OR external_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS product_media_product_idx ON product_media(product_id, role, position);

/* ---- integration reconciliation (035 first, 049 second): union schema, no side dropped ---- */
-- Agent D1 media columns when 035 created the table first:
ALTER TABLE product_media ADD COLUMN IF NOT EXISTS external_url text;
ALTER TABLE product_media ADD COLUMN IF NOT EXISTS poster_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE product_media ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE product_media ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE product_media ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- 035 required url; external media rows only carry external_url:
ALTER TABLE product_media ALTER COLUMN url DROP NOT NULL;
-- Union of both role vocabularies (035: hero/gallery/flat_lay/on_model/detail/size_guide/video,
-- 049: gallery/flat_lay/video/poster/size_guide/campaign):
ALTER TABLE product_media DROP CONSTRAINT IF EXISTS product_media_role_check;
ALTER TABLE product_media ADD CONSTRAINT product_media_role_check
  CHECK (role IN ('hero', 'gallery', 'flat_lay', 'on_model', 'detail', 'size_guide', 'video', 'poster', 'campaign'));
-- 049 required file_id OR external_url; 035 rows also legitimately carry only url:
ALTER TABLE product_media DROP CONSTRAINT IF EXISTS product_media_file_or_external_check;
ALTER TABLE product_media ADD CONSTRAINT product_media_file_or_external_check
  CHECK (file_id IS NOT NULL OR external_url IS NOT NULL OR url IS NOT NULL);

CREATE TABLE IF NOT EXISTS video_assets (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  media_id uuid REFERENCES product_media(id) ON DELETE CASCADE,
  blog_post_code text,
  poster_url text,
  duration_seconds numeric(10, 2),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  cdn_ready boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_assets_product_idx ON video_assets(product_id) WHERE active;

CREATE TABLE IF NOT EXISTS video_analytics_events (
  id uuid PRIMARY KEY,
  video_id text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  blog_post_code text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id text,
  session_id text,
  event_type text NOT NULL CHECK (event_type IN ('play', '25', '50', '75', 'complete', 'pause', 'seek', 'error')),
  position_seconds numeric(10, 2),
  watched_seconds numeric(10, 2),
  surface text NOT NULL DEFAULT 'product',
  source text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_analytics_video_idx ON video_analytics_events(video_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS video_analytics_product_idx ON video_analytics_events(product_id, created_at DESC);

-- =========================================================================
-- merged from 021_permissions_hardening.sql when this branch's migrations moved to the 045-049 slot
-- =========================================================================
-- Permissions for the requirement groups delivered in this stage (15-24, 85-121, 136-143, 313-314).
INSERT INTO permissions(code, title) VALUES
  ('buyers:manage', 'مدیریت خریداران ۳۶۰ و اعتبار'),
  ('automation:manage', 'مدیریت مرکز اتوماسیون'),
  ('tracking:manage', 'مدیریت پیگیری مرسولات'),
  ('reviews:moderate', 'مدیریت و بازبینی نظرات محصول'),
  ('recommendations:manage', 'مدیریت موتور پیشنهاد'),
  ('media:manage', 'مدیریت رسانه و ویدیوی محصول'),
  ('profile:manage', 'اصلاح پروفایل کاربران'),
  ('security:manage', 'مدیریت امنیت حساب و 2FA')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'buyers:manage'), ('admin', 'automation:manage'), ('admin', 'tracking:manage'),
  ('admin', 'reviews:moderate'), ('admin', 'recommendations:manage'), ('admin', 'media:manage'),
  ('admin', 'profile:manage'), ('admin', 'security:manage'),
  ('operations', 'tracking:manage'), ('operations', 'automation:manage'),
  ('support', 'reviews:moderate'), ('support', 'profile:manage'),
  ('finance', 'buyers:manage')
ON CONFLICT DO NOTHING;

-- The automation event catalog (item 86/87) is product state, not code: external
-- workflow builders need to discover which events exist and what they carry.
CREATE TABLE IF NOT EXISTS automation_event_catalog (
  event_type text PRIMARY KEY,
  title text NOT NULL,
  domain text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  description text NOT NULL DEFAULT '',
  payload_example jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO automation_event_catalog(event_type, title, domain, description, payload_example) VALUES
  ('order.created', 'ایجاد سفارش', 'orders', 'سفارش جدید ثبت شد.', '{"orderId":"uuid","reference":"KV-1001"}'),
  ('order.paid', 'پرداخت سفارش', 'orders', 'پرداخت سفارش با تأیید درگاه نهایی شد.', '{"orderId":"uuid","paymentIntentId":"uuid"}'),
  ('order.shipped', 'ارسال سفارش', 'orders', 'سفارش تحویل شرکت حمل شد.', '{"orderId":"uuid","trackingCode":"TPX-1"}'),
  ('order.delivered', 'تحویل سفارش', 'orders', 'سفارش به مشتری تحویل شد.', '{"orderId":"uuid"}'),
  ('product.created', 'ایجاد محصول', 'catalog', 'محصول جدید ساخته شد.', '{"productId":"uuid","status":"draft"}'),
  ('product.reviewed', 'بازبینی محصول', 'catalog', 'نتیجه بازبینی محصول بازارچه ثبت شد.', '{"productId":"uuid","decision":"approved"}'),
  ('customer.created', 'ثبت‌نام مشتری', 'crm', 'کاربر جدید ثبت‌نام کرد.', '{"userId":"uuid"}'),
  ('customer.updated', 'به‌روزرسانی مشتری', 'crm', 'اطلاعات مشتری تغییر کرد.', '{"userId":"uuid","fields":["displayName"]}'),
  ('membership.activated', 'فعال‌سازی عضویت', 'membership', 'عضویت پس از پرداخت تأییدشده فعال شد.', '{"membershipId":"uuid","userId":"uuid"}'),
  ('membership.expiring', 'نزدیک به انقضای عضویت', 'membership', 'کمتر از ۷ روز تا انقضای عضویت باقی است.', '{"membershipId":"uuid","endsAt":"2026-01-01T00:00:00Z"}'),
  ('membership.expired', 'انقضای عضویت', 'membership', 'عضویت منقضی شد.', '{"membershipId":"uuid"}'),
  ('cart.abandoned', 'سبد رهاشده', 'cart', 'سبد خرید بدون تکمیل رها شد.', '{"userId":"uuid","cartValueRial":"1000000"}'),
  ('coupon.used', 'استفاده از کوپن', 'promotion', 'کوپن در سفارش مصرف شد.', '{"couponId":"uuid","orderId":"uuid"}'),
  ('review.created', 'ثبت نظر محصول', 'reviews', 'مشتری نظر و امتیاز ثبت کرد.', '{"reviewId":"uuid","productId":"uuid","rating":5}'),
  ('ticket.created', 'ایجاد تیکت', 'support', 'تیکت پشتیبانی جدید ثبت شد.', '{"ticketId":"uuid"}'),
  ('invoice.issued', 'صدور فاکتور', 'finance', 'فاکتور رسمی صادر شد.', '{"invoiceId":"uuid","number":"INV-1001"}'),
  ('shipment.tracking.updated', 'به‌روزرسانی رهگیری', 'logistics', 'وضعیت مرسوله تغییر کرد.', '{"shipmentId":"uuid","status":"in_transit"}'),
  ('recommendation.purchased', 'خرید از پیشنهاد', 'recommendation', 'محصول پیشنهادی خریداری شد.', '{"slot":"home.for_you","productId":"uuid"}')
ON CONFLICT (event_type) DO NOTHING;

-- Targeted SMS campaigns (requirement 22): the audience may be a CRM segment or
-- a smart label, not only one of the legacy buckets.
ALTER TABLE sms_campaigns DROP CONSTRAINT IF EXISTS sms_campaigns_audience_check;
ALTER TABLE sms_campaigns ADD CONSTRAINT sms_campaigns_audience_check
  CHECK (audience IN ('all', 'retail', 'wholesale', 'vip', 'suppliers')
      OR audience LIKE 'segment:%' OR audience LIKE 'label:%');

-- =========================================================================
-- merged from 022_promo_safety_templates.sql when this branch's migrations moved to the 045-049 slot
-- =========================================================================
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

-- =========================================================================
-- merged from 023_growth_gaps.sql when this branch's migrations moved to the 045-049 slot
-- =========================================================================
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


-- =========================================================================
-- Hardening (final pass, no new features): the audit rules of this branch
-- are enforced by the schema itself, not only by application code.
-- =========================================================================

-- 1) Transactional vs marketing SMS are different categories, and a delivery
--    can be blocked before it ever reaches the provider.
ALTER TABLE sms_deliveries ADD COLUMN IF NOT EXISTS category text;
UPDATE sms_deliveries SET category = 'transactional' WHERE category IS NULL;
ALTER TABLE sms_deliveries ALTER COLUMN category SET DEFAULT 'transactional';
ALTER TABLE sms_deliveries ALTER COLUMN category SET NOT NULL;
ALTER TABLE sms_deliveries DROP CONSTRAINT IF EXISTS sms_deliveries_category_check;
ALTER TABLE sms_deliveries ADD CONSTRAINT sms_deliveries_category_check
  CHECK (category IN ('transactional', 'marketing'));
ALTER TABLE sms_deliveries ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE sms_deliveries DROP CONSTRAINT IF EXISTS sms_deliveries_status_check;
ALTER TABLE sms_deliveries ADD CONSTRAINT sms_deliveries_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown', 'blocked'));
-- Rows queued before the column existed are re-classified from their event type.
UPDATE sms_deliveries d SET category = 'marketing'
 WHERE d.category = 'transactional' AND d.event_id IN (
   SELECT o.id FROM outbox_events o
   WHERE o.event_type IN ('crm.campaign_sms', 'crm.automation_message', 'cart.nudged'));
CREATE INDEX IF NOT EXISTS sms_deliveries_category_idx ON sms_deliveries(category, created_at DESC);

-- 2) Review integrity (items 106/107): a rating, its author, its product and the
--    verified-purchase flag are written once from real order data and can never
--    be rewritten — moderation only moves the visibility status.
CREATE OR REPLACE FUNCTION kolbe_customer_reviews_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.rating IS DISTINCT FROM OLD.rating THEN
    RAISE EXCEPTION 'review rating is immutable (requirement 107)' USING ERRCODE = '23514';
  END IF;
  IF NEW.verified_purchase IS DISTINCT FROM OLD.verified_purchase THEN
    RAISE EXCEPTION 'verified_purchase comes from a real order (requirement 106)' USING ERRCODE = '23514';
  END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'review ownership is immutable (requirement 106)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_reviews_immutable ON customer_reviews;
CREATE TRIGGER customer_reviews_immutable BEFORE UPDATE ON customer_reviews
  FOR EACH ROW EXECUTE FUNCTION kolbe_customer_reviews_immutable();

-- 3) Recommendations keep no copy of price or availability: the tables below are
--    documented as exposure/manual-pin stores, and the API always reads the
--    canonical catalogue (products.cash_price_rial) and WMS (stock_balances).
COMMENT ON TABLE recommendation_slots IS
  'Slot definition only (strategy + config). Never stores price or stock (requirement 118).';
COMMENT ON TABLE recommendation_manual_items IS
  'Manual pins by product id only; price/availability are resolved from catalogue + WMS at request time.';
COMMENT ON TABLE recommendation_events IS
  'Exposure/click/atc/purchase events. revenue_rial is the realised order revenue, never a cached price.';
COMMENT ON TABLE customer_interest_signals IS
  'Behavioural signals (views, wishlist, search, returns). No denormalised price or stock.';
