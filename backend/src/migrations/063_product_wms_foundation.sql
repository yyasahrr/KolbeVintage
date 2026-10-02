-- 063: Product/WMS foundation (Master Prompt 1).
-- Boundaries: CATALOG (what) / OFFER (how sold) / AVAILABILITY (how much now) /
-- WMS (where physically). All additive — no destructive change, legacy data kept.
--
--   §8-§10  category_profiles: Category becomes the Source of Truth for spec
--           template + size guide + required fields (product_type stays as a
--           deprecated legacy column, hidden from the new UI).
--   §16-§17 products.inventory_setup: «نیازمند راه‌اندازی» is a REAL state —
--           '—' (pending = profile not configured) is distinct from 0 (configured
--           but zero stock). Existing products are grandfathered as configured.
--   §29-§34 supplier_offers + supplier_capacity_reservations: supplier external
--           declared capacity is an AVAILABILITY concept — never stock_balances.
--   §25-§27 supplier_series_inbounds: advance consignment inbound
--           (request → approve → dispatch → receive → QC → verified
--           supplier-owned series stock at the central wholesale warehouse).
--   §37     supplier_stock_returns: supplier takes back its own AVAILABLE stock.
--   §50     ownership_conversions gains series-stock scope (supplier → kolbe at
--           STOCK level through an audited document, never a silent owner flip).

-- ---------- §8: Category = Source of Truth ----------
-- products.category is historically free text; the profile keys that text and
-- carries the schema expectations. No destructive rename of the legacy column.
CREATE TABLE IF NOT EXISTS category_profiles (
  id uuid PRIMARY KEY,
  category text NOT NULL UNIQUE CHECK (char_length(category) BETWEEN 1 AND 120),
  spec_template_id uuid REFERENCES spec_templates(id),
  size_guide_id uuid REFERENCES size_guides(id),
  allowed_sizes jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  variant_attributes jsonb NOT NULL DEFAULT '["color","size"]'::jsonb,
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- §16: inventory setup is an explicit lifecycle state ----------
ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_setup text NOT NULL DEFAULT 'configured';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_inventory_setup_check;
ALTER TABLE products ADD CONSTRAINT products_inventory_setup_check
  CHECK (inventory_setup IN ('pending', 'configured'));
-- Existing products already operate (grandfathered 'configured'); NEW kolbe
-- products are inserted as 'pending' by the application.
CREATE INDEX IF NOT EXISTS products_needs_setup_idx ON products(created_at DESC)
  WHERE inventory_setup = 'pending';

-- §30: wholesale max order (series) at product level; offer-level overrides below.
ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_max_order integer
  CHECK (wholesale_max_order IS NULL OR wholesale_max_order > 0);

-- ---------- §29: supplier wholesale offer (OFFER domain, not stock) ----------
CREATE TABLE IF NOT EXISTS supplier_offers (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  color_label text,
  series_template_id uuid REFERENCES series_templates(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  fulfillment_mode text NOT NULL DEFAULT 'order_driven'
    CHECK (fulfillment_mode IN ('order_driven', 'stock_at_kolbe', 'hybrid')),
  wholesale_price_rial bigint CHECK (wholesale_price_rial IS NULL OR wholesale_price_rial >= 0),
  min_order_series integer NOT NULL DEFAULT 1 CHECK (min_order_series > 0),
  max_order_series integer CHECK (max_order_series IS NULL OR max_order_series >= min_order_series),
  -- §31: external declared capacity — an AVAILABILITY claim, never warehouse stock.
  declared_capacity integer NOT NULL DEFAULT 0 CHECK (declared_capacity >= 0),
  reserved_external integer NOT NULL DEFAULT 0 CHECK (reserved_external >= 0),
  safety_buffer integer NOT NULL DEFAULT 0 CHECK (safety_buffer >= 0),
  lead_time_days integer NOT NULL DEFAULT 3 CHECK (lead_time_days BETWEEN 0 AND 60),
  capacity_confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_offers_scope_uniq ON supplier_offers (
  supplier_id, product_id,
  COALESCE(color_label, ''),
  COALESCE(series_template_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX IF NOT EXISTS supplier_offers_product_idx ON supplier_offers(product_id, status);
CREATE INDEX IF NOT EXISTS supplier_offers_supplier_idx ON supplier_offers(supplier_id, status);
CREATE INDEX IF NOT EXISTS supplier_offers_freshness_idx ON supplier_offers(capacity_confirmed_at)
  WHERE status = 'active';

-- §33: atomic external capacity reservations with TTL (consumed by Prompt 2).
CREATE TABLE IF NOT EXISTS supplier_capacity_reservations (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES supplier_offers(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed', 'expired')),
  reference_type text,
  reference_id uuid,
  expires_at timestamptz,
  note text NOT NULL DEFAULT '',
  idempotency_key text UNIQUE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_capacity_res_offer_idx ON supplier_capacity_reservations(offer_id, status);
CREATE INDEX IF NOT EXISTS supplier_capacity_res_expiry_idx ON supplier_capacity_reservations(expires_at)
  WHERE status = 'active';

-- ---------- §26: advance supplier inbound (consignment, SERIES unit) ----------
CREATE SEQUENCE IF NOT EXISTS supplier_inbound_seq START 1000;
CREATE TABLE IF NOT EXISTS supplier_series_inbounds (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL REFERENCES products(id),
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  color_label text,
  warehouse_id uuid REFERENCES warehouses(id),        -- fixed at approval (central wholesale)
  expected_series integer NOT NULL CHECK (expected_series BETWEEN 1 AND 10000),
  received_series integer CHECK (received_series IS NULL OR received_series >= 0),
  qc_passed_series integer CHECK (qc_passed_series IS NULL OR qc_passed_series >= 0),
  qc_rejected_series integer CHECK (qc_rejected_series IS NULL OR qc_rejected_series >= 0),
  shortage_series integer CHECK (shortage_series IS NULL OR shortage_series >= 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'approved', 'rejected', 'dispatched', 'received', 'qc_completed', 'cancelled'
  )),
  recipe_snapshot jsonb,
  batch_reference text,
  carrier text,
  note text NOT NULL DEFAULT '',
  rejection_reason text,
  reviewed_by uuid REFERENCES users(id),
  approved_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  qc_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_series_inbounds_supplier_idx ON supplier_series_inbounds(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supplier_series_inbounds_status_idx ON supplier_series_inbounds(status, created_at DESC);

-- ---------- §37: supplier stored-stock return ----------
CREATE SEQUENCE IF NOT EXISTS supplier_return_seq START 1000;
CREATE TABLE IF NOT EXISTS supplier_stock_returns (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES users(id),
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  series_count integer NOT NULL CHECK (series_count > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'approved', 'rejected', 'completed', 'cancelled'
  )),
  recipe_snapshot jsonb,
  note text NOT NULL DEFAULT '',
  rejection_reason text,
  reviewed_by uuid REFERENCES users(id),
  approved_at timestamptz,
  completed_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_stock_returns_supplier_idx ON supplier_stock_returns(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supplier_stock_returns_status_idx ON supplier_stock_returns(status, created_at DESC);

-- ---------- §50: ownership conversion gains STOCK (series) scope ----------
-- 'series_stock' = conversion of INTACT SERIES held at kolbe (supplier → kolbe) —
-- additive extension of the 055 enum; legacy values untouched.
ALTER TABLE ownership_conversions DROP CONSTRAINT IF EXISTS ownership_conversions_conversion_type_check;
ALTER TABLE ownership_conversions ADD CONSTRAINT ownership_conversions_conversion_type_check
  CHECK (conversion_type IN (
    'purchase_acquisition', 'ownership_transfer', 'consignment_conversion',
    'purchase_buyout', 'consignment_settled', 'contract_transfer', 'series_stock'
  ));
ALTER TABLE ownership_conversions ADD COLUMN IF NOT EXISTS series_template_id uuid REFERENCES series_templates(id);
ALTER TABLE ownership_conversions ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id);
ALTER TABLE ownership_conversions ADD COLUMN IF NOT EXISTS series_count integer
  CHECK (series_count IS NULL OR series_count > 0);

-- ---------- §48: new auditable series movement kinds ----------
-- return_out (supplier takes stock back), conversion_out/conversion_in
-- (ownership conversion debits supplier scope, credits kolbe scope).
ALTER TABLE series_stock_movements DROP CONSTRAINT IF EXISTS series_stock_movements_movement_type_check;
ALTER TABLE series_stock_movements ADD CONSTRAINT series_stock_movements_movement_type_check
  CHECK (movement_type IN (
    'stocktake', 'receipt', 'reserve', 'release', 'consume', 'dispatch_break',
    'incoming', 'incoming_receive', 'incoming_cancel', 'qc_reject', 'adjust',
    'return_out', 'conversion_out', 'conversion_in'
  ));
