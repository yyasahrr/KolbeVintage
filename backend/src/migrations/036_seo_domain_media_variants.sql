-- Req 235: CMS entities are connected to a single SEO Domain (not SEO fields living inside the CMS).
-- Req 234/334: server-side media variants (responsive widths, avatar resize) are cached per file.

CREATE TABLE IF NOT EXISTS seo_entries (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('page', 'category', 'vibe', 'collection', 'product')),
  entity_key text NOT NULL,
  title text,
  description text,
  canonical_path text,
  robots_index boolean NOT NULL DEFAULT true,
  robots_follow boolean NOT NULL DEFAULT true,
  og_title text,
  og_description text,
  og_image text,
  twitter_card text NOT NULL DEFAULT 'summary_large_image' CHECK (twitter_card IN ('summary', 'summary_large_image')),
  schema_type text,
  schema_extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_key)
);
CREATE INDEX IF NOT EXISTS seo_entries_type_idx ON seo_entries(entity_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS seo_entry_versions (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES seo_entries(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, version)
);

-- One-time move of the legacy CMS-local SEO JSON into the SEO Domain. The CMS columns stay only for
-- backward compatibility and are no longer read by the storefront.
INSERT INTO seo_entries(id, entity_type, entity_key, title, description, canonical_path, robots_index)
SELECT gen_random_uuid(), 'page', p.code, NULLIF(p.seo->>'title', ''), NULLIF(p.seo->>'description', ''),
       NULLIF(p.seo->>'canonical', ''), COALESCE((p.seo->>'index')::boolean, true)
FROM cms_pages p WHERE p.seo <> '{}'::jsonb
ON CONFLICT (entity_type, entity_key) DO NOTHING;

INSERT INTO seo_entries(id, entity_type, entity_key, title, description)
SELECT gen_random_uuid(), 'category', c.slug, NULLIF(c.seo->>'title', ''), NULLIF(c.seo->>'description', '')
FROM cms_categories c WHERE c.seo <> '{}'::jsonb
ON CONFLICT (entity_type, entity_key) DO NOTHING;

INSERT INTO seo_entries(id, entity_type, entity_key, title, description)
SELECT gen_random_uuid(), 'vibe', v.slug, NULLIF(v.seo->>'title', ''), NULLIF(v.seo->>'description', '')
FROM cms_vibes v WHERE v.seo <> '{}'::jsonb
ON CONFLICT (entity_type, entity_key) DO NOTHING;

INSERT INTO seo_entries(id, entity_type, entity_key, title, description)
SELECT gen_random_uuid(), 'collection', c.code, NULLIF(c.seo->>'title', ''), NULLIF(c.seo->>'description', '')
FROM cms_collections c WHERE c.seo <> '{}'::jsonb
ON CONFLICT (entity_type, entity_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS media_variants (
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  width integer NOT NULL,
  format text NOT NULL CHECK (format IN ('webp', 'jpeg', 'png')),
  storage_key text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, width, format)
);

INSERT INTO permissions(code, title) VALUES ('seo:manage', 'مدیریت دامنه سئو (عنوان، توضیح، Canonical، Schema، شبکه‌های اجتماعی، ایندکس)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES ('admin', 'seo:manage') ON CONFLICT DO NOTHING;
