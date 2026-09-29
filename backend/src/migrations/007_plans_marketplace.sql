-- Plans affect the account for real: features, permissions and purchase
-- conditions live on the plan (items 7-8).
ALTER TABLE membership_plans ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE membership_plans ADD COLUMN permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE membership_plans ADD COLUMN description text NOT NULL DEFAULT '';

-- Marketplace product review with documents and publishing rules (item 3).
CREATE TABLE product_documents (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('image', 'video', 'certificate', 'spec_sheet', 'other')),
  title text NOT NULL,
  file_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_documents_product_idx ON product_documents(product_id, created_at);

CREATE TABLE product_reviews (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  documents_checked boolean NOT NULL DEFAULT false,
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_reviews_product_idx ON product_reviews(product_id, created_at DESC);
CREATE TRIGGER product_reviews_immutable BEFORE UPDATE OR DELETE ON product_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();

INSERT INTO permissions(code, title) VALUES
  ('marketplace:review', 'بازبینی محصولات بازارچه'), ('plans:read', 'مشاهده پلن‌های عضویت')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'marketplace:review'), ('admin', 'plans:read'),
  ('operations', 'marketplace:review'), ('operations', 'plans:read')
ON CONFLICT DO NOTHING;
