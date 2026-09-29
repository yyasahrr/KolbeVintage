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
