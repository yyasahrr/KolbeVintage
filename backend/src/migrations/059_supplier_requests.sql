-- 059: Supplier replenishment / new-product requests (section I).
-- Multi-item requests (max 10 items enforced server-side), admin review with mandatory
-- detailed rejection reason, revision history preserved relationally.

CREATE SEQUENCE IF NOT EXISTS supplier_request_seq START 1000;

CREATE TABLE IF NOT EXISTS supplier_requests (
  id uuid PRIMARY KEY,
  request_number text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'approved', 'rejected', 'needs_revision',
    'dispatched', 'received', 'closed', 'cancelled'
  )),
  note text NOT NULL DEFAULT '',
  rejection_reason text,
  revision_note text,
  revision_count integer NOT NULL DEFAULT 0,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  dispatched_at timestamptz,
  dispatch_batch_reference text,
  dispatch_carrier text,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_requests_supplier_idx ON supplier_requests(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supplier_requests_status_idx ON supplier_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_request_items (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES supplier_requests(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('new_product', 'replenishment')),
  product_id uuid REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  proposed_name text,
  proposed_color text,
  proposed_size text,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  unit_cost_rial bigint CHECK (unit_cost_rial IS NULL OR unit_cost_rial >= 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_request_items_target CHECK (
    (item_type = 'replenishment' AND variant_id IS NOT NULL)
    OR (item_type = 'new_product' AND proposed_name IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS supplier_request_items_request_idx ON supplier_request_items(request_id);

CREATE TABLE IF NOT EXISTS supplier_request_revisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES supplier_requests(id) ON DELETE CASCADE,
  revision_no integer NOT NULL,
  snapshot jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, revision_no)
);

-- Link receipts created from a dispatched supplier request back to it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_receipts_supplier_request_fk'
  ) THEN
    ALTER TABLE stock_receipts
      ADD CONSTRAINT stock_receipts_supplier_request_fk
      FOREIGN KEY (supplier_request_id) REFERENCES supplier_requests(id);
  END IF;
END $$;
