-- CUSTOMER PRIMARY OTP LOGIN (mobile + code) — remediation of the unified Auth model.
--
-- The customer/VIP login offers two REAL methods on ONE account: mobile + one-time code and
-- email + password. The code-based method needs its own challenge purpose so that a passwordless
-- login attempt can never be confused with (or consumed by) a two-factor challenge, and so an
-- operator can audit them separately.
--
-- Registration is mobile-first, so the signup challenge exists BEFORE the account does: the
-- challenge is bound to the verified number, not to a user row. Everything else is unchanged.
--
-- Additive + idempotent: widens the purpose CHECK, relaxes user_id for the pre-account case and
-- adds lookup indexes. No data is rewritten and no existing row is invalidated.

ALTER TABLE two_factor_challenges ALTER COLUMN user_id DROP NOT NULL;
-- The signup code is sent BEFORE the account exists, so the delivery row carries the number only.
ALTER TABLE sms_deliveries ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE two_factor_challenges DROP CONSTRAINT IF EXISTS two_factor_challenges_purpose_check;
ALTER TABLE two_factor_challenges ADD CONSTRAINT two_factor_challenges_purpose_check
  CHECK (purpose IN ('login', 'sensitive_action', 'customer_login', 'customer_signup'));

-- The passwordless login is looked up by the phone the code was sent to (challenge id remains the
-- canonical handle; this index serves rate-limit/abuse checks per number).
CREATE INDEX IF NOT EXISTS two_factor_challenges_customer_login_idx
  ON two_factor_challenges(phone, purpose) WHERE consumed_at IS NULL AND purpose IN ('customer_login', 'customer_signup');

COMMENT ON COLUMN two_factor_challenges.purpose IS
  'login = two-factor step-up, sensitive_action = profile/security action, customer_login = passwordless customer/VIP sign-in, customer_signup = mobile verification before the customer account exists.';

-- Self-service password recovery reuses this table; the token is only ever stored hashed and a
-- recovery token may be issued without an operator (created_by stays NULL for public recovery).
COMMENT ON TABLE password_reset_tokens IS
  'One-time password tokens (hash only). Public "forgot password" recovery and operator reset both write here.';
