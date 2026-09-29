-- Persistent SEO, search, editorial and media metadata. Large binaries are never stored in PostgreSQL.
CREATE TABLE seo_pages (
  entity_type text NOT NULL CHECK (entity_type IN ('site','product','category','brand','blog','cms','landing')),
  entity_key text NOT NULL,
  seo_title text NOT NULL DEFAULT '',
  meta_description text NOT NULL DEFAULT '',
  slug text NOT NULL DEFAULT '',
  canonical_url text NOT NULL DEFAULT '',
  is_indexable boolean NOT NULL DEFAULT true,
  is_followable boolean NOT NULL DEFAULT true,
  social_title text NOT NULL DEFAULT '',
  social_description text NOT NULL DEFAULT '',
  social_image_url text NOT NULL DEFAULT '',
  schema_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_key)
);
CREATE UNIQUE INDEX seo_pages_slug_unique ON seo_pages(slug) WHERE slug <> '';
CREATE INDEX seo_pages_indexable_idx ON seo_pages(entity_type, is_indexable) WHERE is_indexable;

CREATE TABLE seo_page_revisions (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  version integer NOT NULL,
  actor_id uuid REFERENCES users(id),
  before_value jsonb,
  after_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_type, entity_key, version)
);
CREATE TRIGGER seo_page_revisions_immutable BEFORE UPDATE OR DELETE ON seo_page_revisions FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();
CREATE INDEX seo_page_revisions_history_idx ON seo_page_revisions(entity_type, entity_key, version DESC);

CREATE TABLE seo_redirects (
  id uuid PRIMARY KEY,
  source_path text NOT NULL UNIQUE CHECK (source_path LIKE '/%'),
  target_path text,
  status_code smallint NOT NULL CHECK (status_code IN (301,302,410)),
  active boolean NOT NULL DEFAULT true,
  hit_count bigint NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status_code = 410 AND target_path IS NULL) OR (status_code IN (301,302) AND target_path LIKE '/%'))
);
CREATE INDEX seo_redirect_active_idx ON seo_redirects(source_path) WHERE active;

CREATE TABLE seo_facet_policies (
  facet_key text PRIMARY KEY,
  is_indexable boolean NOT NULL DEFAULT false,
  crawl_allowed boolean NOT NULL DEFAULT false,
  canonical_target text NOT NULL DEFAULT '/shop',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO seo_facet_policies(facet_key, canonical_target) VALUES
 ('category','/shop'),('brand','/shop'),('color','/shop'),('size','/shop'),('price','/shop'),('availability','/shop'),('discount','/shop'),('rating','/shop'),('season','/shop'),('vibe','/shop'),('attribute','/shop')
ON CONFLICT DO NOTHING;

CREATE TABLE seo_not_found_hits (
  path text NOT NULL,
  hit_day date NOT NULL DEFAULT CURRENT_DATE,
  hit_count bigint NOT NULL DEFAULT 1 CHECK (hit_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_referrer text NOT NULL DEFAULT '',
  PRIMARY KEY (path, hit_day)
);
CREATE INDEX seo_not_found_recent_idx ON seo_not_found_hits(hit_day DESC, hit_count DESC);

CREATE TABLE seo_crawl_runs (
  id uuid PRIMARY KEY,
  started_by uuid REFERENCES users(id),
  source text NOT NULL CHECK (source IN ('manual','scheduled')),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
CREATE TABLE seo_crawl_issues (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES seo_crawl_runs(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('error','warning','notice')),
  issue_code text NOT NULL,
  page_url text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  fixed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seo_crawl_issues_run_idx ON seo_crawl_issues(run_id, severity, issue_code);

-- Query text is retained for at most 30 days; it is aggregated without user/account identifiers.
CREATE TABLE search_metrics (
  query_hash char(64) NOT NULL,
  normalized_query text NOT NULL CHECK (length(normalized_query) BETWEEN 1 AND 200),
  metric_day date NOT NULL DEFAULT CURRENT_DATE,
  search_count integer NOT NULL DEFAULT 0 CHECK (search_count >= 0),
  last_result_count integer NOT NULL DEFAULT 0 CHECK (last_result_count >= 0),
  click_count integer NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  conversion_count integer NOT NULL DEFAULT 0 CHECK (conversion_count >= 0),
  zero_result boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  PRIMARY KEY(query_hash, metric_day),
  CHECK (expires_at <= last_seen_at + interval '30 days' + interval '1 minute')
);
CREATE INDEX search_metrics_expiry_idx ON search_metrics(expires_at);
CREATE INDEX search_metrics_admin_idx ON search_metrics(zero_result, metric_day DESC, search_count DESC);

CREATE TABLE editorial_posts (
  id uuid PRIMARY KEY,
  post_type text NOT NULL CHECK (post_type IN ('article','video')),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  excerpt text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  cover_url text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_type text CHECK (source_type IN ('youtube','direct','external')),
  source_url text NOT NULL DEFAULT '',
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  seo_title text NOT NULL DEFAULT '',
  seo_description text NOT NULL DEFAULT '',
  related_product_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at timestamptz,
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (post_type = 'article' OR source_type IS NOT NULL)
);
CREATE INDEX editorial_posts_public_idx ON editorial_posts(post_type, published_at DESC) WHERE status='published';
CREATE INDEX editorial_posts_search_idx ON editorial_posts USING gin(to_tsvector('simple', title || ' ' || excerpt || ' ' || body));

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  media_type text NOT NULL CHECK (media_type IN ('image','video','pdf')),
  source_type text NOT NULL CHECK (source_type IN ('object_storage','youtube','external')),
  storage_key text NOT NULL DEFAULT '',
  public_url text NOT NULL,
  mime_type text NOT NULL DEFAULT '',
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  alt_text text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  caption text NOT NULL DEFAULT '',
  file_name text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_status text NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('pending','processing','ready','failed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_type_date_idx ON media_assets(media_type, created_at DESC);
CREATE INDEX media_assets_metadata_idx ON media_assets USING gin(metadata);

CREATE TABLE product_media (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  purpose text NOT NULL DEFAULT 'gallery',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(product_id, variant_id, media_asset_id)
);
CREATE INDEX product_media_gallery_idx ON product_media(product_id, variant_id, position);

CREATE TABLE media_upload_intents (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size > 0),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_upload_intents_expiry_idx ON media_upload_intents(expires_at) WHERE completed_at IS NULL;

CREATE TABLE seo_integration_status (
  provider text PRIMARY KEY,
  status text NOT NULL DEFAULT 'not_configured' CHECK(status IN ('not_configured','configured','disconnected','connected','error')),
  property_url text NOT NULL DEFAULT '',
  last_synced_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO seo_integration_status(provider) VALUES ('google_search_console'),('google_merchant_center'),('cdn'),('object_storage') ON CONFLICT DO NOTHING;
CREATE TABLE seo_site_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  robots_text text NOT NULL DEFAULT E'User-agent: *\\nAllow: /\\nSitemap: /sitemap.xml',
  crawl_schedule text NOT NULL DEFAULT 'manual' CHECK(crawl_schedule IN ('manual','daily','weekly')),
  organization_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  merchant_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO seo_site_settings(id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE search_synonyms (
  phrase text PRIMARY KEY,
  replacement text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO permissions(code, title) VALUES
 ('seo:read','مشاهده SEO'),('seo:manage','مدیریت SEO'),('seo:redirects','مدیریت ریدایرکت‌ها'),
 ('seo:technical','مدیریت بررسی فنی'),('seo:integrations','اتصال‌های SEO'),
 ('content:manage','مدیریت محتوا'),('media:manage','مدیریت رسانه'),('search:analytics','مشاهده آمار جست‌وجو'),('search:manage','مدیریت مترادف‌های جست‌وجو')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) SELECT 'admin', code FROM permissions
WHERE code LIKE 'seo:%' OR code IN ('content:manage','media:manage','search:analytics','search:manage') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES ('operations','seo:read') ON CONFLICT DO NOTHING;
