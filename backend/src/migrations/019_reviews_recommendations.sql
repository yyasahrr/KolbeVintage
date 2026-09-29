-- Requirements 105-121: product ratings/reviews with verified purchase and
-- moderation, plus the independent Recommendation domain (slots, strategies,
-- tracking events and admin analytics).
--
-- NOTE: the pre-existing `product_reviews` table is the marketplace *review
-- decision* log of supplier products (item 3). Customer ratings live here.

CREATE TABLE IF NOT EXISTS customer_reviews (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  verified_purchase boolean NOT NULL DEFAULT false,
  helpful_count integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  report_count integer NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  moderation_note text,
  moderated_by uuid REFERENCES users(id),
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_reviews_product_user_idx
  ON customer_reviews(product_id, user_id, COALESCE(order_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS customer_reviews_product_status_idx ON customer_reviews(product_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_reviews_user_idx ON customer_reviews(user_id, created_at DESC);
COMMENT ON TABLE customer_reviews IS 'Customer product ratings. Moderation changes only status — never the rating value (item 107).';

CREATE TABLE IF NOT EXISTS customer_review_reports (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL REFERENCES customer_reviews(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_review_reports_review_idx ON customer_review_reports(review_id, created_at DESC);

/* ------------------------------ recommendations ------------------------------ */

CREATE TABLE IF NOT EXISTS recommendation_slots (
  code text PRIMARY KEY,
  title text NOT NULL,
  page_scope text NOT NULL DEFAULT 'global',
  default_strategy text NOT NULL DEFAULT 'popular',
  strategies text[] NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recommendation_manual_items (
  slot_code text NOT NULL REFERENCES recommendation_slots(code) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (slot_code, product_id)
);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id uuid PRIMARY KEY,
  slot_code text NOT NULL,
  strategy text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('shown', 'clicked', 'added_to_cart', 'purchased')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id text,
  session_id text,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  position integer,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  revenue_rial bigint NOT NULL DEFAULT 0 CHECK (revenue_rial >= 0),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommendation_events_slot_idx ON recommendation_events(slot_code, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_events_user_idx ON recommendation_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_events_product_idx ON recommendation_events(product_id, event_type);

-- Personal behavioural signals (item 111) that are cheaper to keep as a compact
-- per-user rollup than to derive from analytics on every request.
CREATE TABLE IF NOT EXISTS customer_interest_signals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('view', 'wishlist', 'cart', 'purchase', 'return', 'search', 'rating', 'category', 'color', 'size')),
  signal_key text NOT NULL,
  weight integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, signal_type, signal_key)
);
CREATE INDEX IF NOT EXISTS customer_interest_signals_user_idx ON customer_interest_signals(user_id, weight DESC);

INSERT INTO recommendation_slots(code, title, page_scope, default_strategy, strategies) VALUES
  ('home.hero_recommendations', 'پیشنهاد قهرمان صفحه اصلی', 'home', 'trending', ARRAY['trending', 'new_arrivals', 'manual_campaign', 'seasonal']),
  ('home.for_you', 'برای شما', 'home', 'personalized', ARRAY['personalized', 'popular', 'trending', 'seasonal']),
  ('product.similar', 'محصولات مشابه', 'product', 'similar', ARRAY['similar', 'collaborative', 'popular']),
  ('product.complete_the_look', 'تکمیل استایل', 'product', 'similar', ARRAY['similar', 'rule_based', 'manual_campaign']),
  ('cart.you_may_like', 'شاید بپسندید', 'cart', 'collaborative', ARRAY['collaborative', 'popular', 'rule_based']),
  ('checkout.last_minute', 'پیشنهاد آخرین لحظه', 'checkout', 'popular', ARRAY['popular', 'rule_based']),
  ('account.for_you', 'پیشنهاد شخصی حساب من', 'account', 'personalized', ARRAY['personalized', 'trending'])
ON CONFLICT (code) DO NOTHING;
