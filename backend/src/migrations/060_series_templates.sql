-- 060: Relational series templates for wholesale (section K).
-- A series is a named recipe of variant quantities; JSON is only ever a snapshot,
-- the relational rows are the source of truth.

CREATE TABLE IF NOT EXISTS series_templates (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS series_templates_product_idx ON series_templates(product_id, active);

CREATE TABLE IF NOT EXISTS series_template_items (
  id uuid PRIMARY KEY,
  series_template_id uuid NOT NULL REFERENCES series_templates(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity_per_series integer NOT NULL CHECK (quantity_per_series > 0 AND quantity_per_series <= 1000),
  UNIQUE (series_template_id, variant_id)
);

CREATE INDEX IF NOT EXISTS series_template_items_template_idx ON series_template_items(series_template_id);
