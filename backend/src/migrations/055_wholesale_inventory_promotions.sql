-- 055_wholesale_inventory_promotions.sql
-- Reconciles Requirements 1 to 10 onto canonical 001..054 schema:
-- 1. Wholesale orders inbound-to-Kolbe warehouse & QC workflow
-- 2. Supplier privacy support & public commercial metadata
-- 3 & 4. Independent Wholesale & Retail inventory domains
-- 5. Official Stock Transfer workflow with append-only movements
-- 6. Ownership-aware transfer & Ownership Conversion records
-- 7, 8, 9, 10. Unified Promotion Engine (Variant, Color, Size, Product, Category targeting)

-- 1. Permissions & Role Mappings (both canonical dot-notation and colon-notation)
INSERT INTO permissions (code, title) VALUES
  ('wholesale.fulfillment', 'Manage supplier wholesale fulfillments and inbound shipments to Kolbe warehouse'),
  ('wholesale.qc', 'Inspect, receive, consolidate, and dispatch wholesale orders at Kolbe warehouse'),
  ('inventory.transfer', 'Create, approve, and complete official stock transfers between domains and warehouses'),
  ('inventory.ownership_conversion', 'Convert supplier-owned wholesale inventory into Kolbe-owned inventory'),
  ('promotions.manage', 'Create, update, and manage coupons, festivals, and promotional discount rules'),
  ('inventory:transfer', 'انتقال رسمی موجودی بین دامنه‌ها و انبارها'),
  ('inventory:ownership', 'مدیریت انتقال مالکیت کالا'),
  ('wholesale:inbound', 'مدیریت مرسولات ورودی و کنترل کیفیت انبار کلبه'),
  ('wholesale:ops', 'مدیریت عملیات تجمیع و کنترل کیفیت سفارش عمده'),
  ('promotions:read', 'مشاهده قوانین تخفیف و جشنواره'),
  ('promotions:write', 'تعریف و ویرایش قوانین تخفیف و جشنواره')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
  SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('supplier', 'wholesale.fulfillment'),
  ('operations', 'wholesale.fulfillment'),
  ('operations', 'wholesale.qc'),
  ('operations', 'inventory.transfer'),
  ('operations', 'inventory.ownership_conversion'),
  ('operations', 'promotions.manage'),
  ('operations', 'inventory:transfer'),
  ('operations', 'wholesale:inbound'),
  ('operations', 'wholesale:ops'),
  ('operations', 'promotions:read')
ON CONFLICT DO NOTHING;

-- 2. Product ownership & public wholesale terms
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sale_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS allow_installments boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disable_installments_on_discount boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ownership_converted_from_supplier_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS ownership_converted_at timestamptz;

UPDATE products
SET owner_type = CASE WHEN supplier_id IS NULL THEN 'kolbe' ELSE 'supplier' END
WHERE owner_type IS NULL;

UPDATE products
SET owner_type = 'supplier',
    retail_enabled = false,
    wholesale_enabled = true
WHERE supplier_id IS NOT NULL
  AND ownership_converted_from_supplier_id IS NULL;

CREATE INDEX IF NOT EXISTS products_owner_type_idx ON products(owner_type, status);

-- 3 & 4. Independent Inventory Domains (retail vs wholesale)
ALTER TABLE stock_balances
  ADD COLUMN IF NOT EXISTS inventory_domain text NOT NULL DEFAULT 'retail'
    CHECK (inventory_domain IN ('retail', 'wholesale'));

-- Migrate existing supplier-owned or wholesale-only balances to 'wholesale' domain before updating PK
UPDATE stock_balances sb
SET inventory_domain = 'wholesale'
FROM product_variants pv, products p, warehouses w
WHERE sb.variant_id = pv.id
  AND p.id = pv.product_id
  AND w.id = sb.warehouse_id
  AND sb.inventory_domain = 'retail'
  AND (
    w.owner_id IS NOT NULL
    OR p.owner_type = 'supplier'
    OR p.supplier_id IS NOT NULL
    OR p.retail_enabled = false
  )
  AND NOT EXISTS (
    SELECT 1 FROM stock_balances existing
    WHERE existing.variant_id = sb.variant_id
      AND existing.warehouse_id = sb.warehouse_id
      AND existing.inventory_domain = 'wholesale'
  );

DO $$
DECLARE
  pk_cols text[];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY k.ord)
    INTO pk_cols
  FROM pg_constraint c
  JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conrelid = 'stock_balances'::regclass
    AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM ARRAY['variant_id', 'warehouse_id', 'inventory_domain'] THEN
    ALTER TABLE stock_balances DROP CONSTRAINT IF EXISTS stock_balances_pkey;
    ALTER TABLE stock_balances ADD PRIMARY KEY (variant_id, warehouse_id, inventory_domain);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_balances_domain_variant_idx
  ON stock_balances(inventory_domain, variant_id);

-- Stock movements domain separation
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS inventory_domain text NOT NULL DEFAULT 'retail'
    CHECK (inventory_domain IN ('retail', 'wholesale'));

CREATE INDEX IF NOT EXISTS stock_movements_domain_lookup_idx
  ON stock_movements(variant_id, warehouse_id, inventory_domain, created_at DESC);

-- Stock reservations domain separation & order_line_id link
ALTER TABLE stock_reservations
  ADD COLUMN IF NOT EXISTS order_line_id uuid REFERENCES order_lines(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS inventory_domain text NOT NULL DEFAULT 'retail'
    CHECK (inventory_domain IN ('retail', 'wholesale'));

CREATE INDEX IF NOT EXISTS stock_reservations_domain_variant_idx
  ON stock_reservations(inventory_domain, variant_id, status);

-- 4b. Reconcile stock_receipts & stock_receipt_lines with 023_wms_locations.sql
ALTER TABLE stock_receipts
  ALTER COLUMN variant_id DROP NOT NULL,
  ALTER COLUMN quantity DROP NOT NULL;

ALTER TABLE stock_receipts
  ADD COLUMN IF NOT EXISTS receipt_number text UNIQUE,
  ADD COLUMN IF NOT EXISTS inventory_domain text NOT NULL DEFAULT 'retail'
    CHECK (inventory_domain IN ('retail', 'wholesale')),
  ADD COLUMN IF NOT EXISTS reference_type text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS reference_id text;

UPDATE stock_receipts
SET receipt_number = reference
WHERE receipt_number IS NULL;

CREATE TABLE IF NOT EXISTS stock_receipt_lines (
  id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  expected_quantity integer NOT NULL CHECK (expected_quantity >= 0),
  received_quantity integer NOT NULL CHECK (received_quantity >= 0),
  accepted_quantity integer NOT NULL CHECK (accepted_quantity >= 0),
  damaged_quantity integer NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  rejected_quantity integer NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  missing_quantity integer NOT NULL DEFAULT 0 CHECK (missing_quantity >= 0),
  unit_cost_rial bigint NOT NULL DEFAULT 0 CHECK (unit_cost_rial >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5 & 6. Ownership Conversions & Official Stock Transfers
CREATE SEQUENCE IF NOT EXISTS ownership_conversion_seq START 100000;
CREATE SEQUENCE IF NOT EXISTS stock_transfer_seq START 100000;

CREATE TABLE IF NOT EXISTS ownership_conversions (
  id uuid PRIMARY KEY,
  reference text UNIQUE,
  conversion_number text UNIQUE,
  reference_code text,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES product_variants(id) ON DELETE RESTRICT,
  from_owner_type text NOT NULL DEFAULT 'supplier' CHECK (from_owner_type IN ('supplier', 'kolbe')),
  to_owner_type text NOT NULL DEFAULT 'kolbe' CHECK (to_owner_type IN ('supplier', 'kolbe')),
  supplier_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  source_warehouse_id uuid REFERENCES warehouses(id),
  destination_warehouse_id uuid REFERENCES warehouses(id),
  destination_domain text NOT NULL DEFAULT 'wholesale'
    CHECK (destination_domain IN ('wholesale', 'retail')),
  conversion_type text NOT NULL DEFAULT 'purchase_acquisition'
    CHECK (conversion_type IN (
      'purchase_acquisition', 'ownership_transfer', 'consignment_conversion',
      'purchase_buyout', 'consignment_settled', 'contract_transfer'
    )),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 100000),
  used_quantity integer NOT NULL DEFAULT 0 CHECK (used_quantity >= 0 AND used_quantity <= quantity),
  unit_cost_rial bigint CHECK (unit_cost_rial IS NULL OR unit_cost_rial >= 0),
  total_cost_rial bigint NOT NULL DEFAULT 0 CHECK (total_cost_rial >= 0),
  enable_retail boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('draft', 'pending', 'approved', 'completed', 'rejected', 'cancelled')),
  receipt_id uuid REFERENCES stock_receipts(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  actor_id uuid REFERENCES users(id),
  converted_by uuid REFERENCES users(id),
  requested_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  completed_by uuid REFERENCES users(id),
  note text,
  notes text NOT NULL DEFAULT '',
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ownership_conversions_product_idx
  ON ownership_conversions(product_id, variant_id, status);

-- Reconcile stock_transfers from 023_wms_locations.sql
ALTER TABLE stock_transfers
  ALTER COLUMN from_warehouse_id DROP NOT NULL,
  ALTER COLUMN to_warehouse_id DROP NOT NULL;

ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_check;

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS transfer_number text UNIQUE,
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_domain text NOT NULL DEFAULT 'retail'
    CHECK (source_domain IN ('wholesale', 'retail')),
  ADD COLUMN IF NOT EXISTS destination_domain text NOT NULL DEFAULT 'retail'
    CHECK (destination_domain IN ('wholesale', 'retail')),
  ADD COLUMN IF NOT EXISTS source_warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS destination_warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS quantity integer CHECK (quantity IS NULL OR (quantity > 0 AND quantity <= 100000)),
  ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS ownership_conversion_id uuid REFERENCES ownership_conversions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'approved', 'in_transit', 'completed', 'cancelled'));

UPDATE stock_transfers SET transfer_number = reference WHERE transfer_number IS NULL;
UPDATE stock_transfers SET source_warehouse_id = from_warehouse_id WHERE source_warehouse_id IS NULL;
UPDATE stock_transfers SET destination_warehouse_id = to_warehouse_id WHERE destination_warehouse_id IS NULL;

CREATE INDEX IF NOT EXISTS stock_transfers_variant_status_idx
  ON stock_transfers(variant_id, status, created_at DESC);

-- 7. Wholesale Orders Inbound-to-Kolbe Warehouse & QC Workflow
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
  status IN (
    'pending_payment', 'paid', 'processing', 'preparing', 'ready_to_ship', 'in_transit', 'shipped', 'delivered', 'cancelled', 'returned',
    'awaiting_supplier', 'supplier_preparing', 'supplier_dispatched', 'arrived_at_kolbe', 'receiving', 'under_inspection',
    'partially_accepted', 'accepted', 'rejected', 'awaiting_consolidation', 'ready_for_vip', 'vip_dispatched'
  )
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfillment_via text NOT NULL DEFAULT 'kolbe_warehouse',
  ADD COLUMN IF NOT EXISTS inventory_domain text NOT NULL DEFAULT 'retail'
    CHECK (inventory_domain IN ('retail', 'wholesale')),
  ADD COLUMN IF NOT EXISTS wholesale_stage text,
  ADD COLUMN IF NOT EXISTS wholesale_fulfillment_status text,
  ADD COLUMN IF NOT EXISTS kolbe_receiving_warehouse_id uuid REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS qc_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS consolidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS consolidated_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS packed_at timestamptz,
  ADD COLUMN IF NOT EXISTS vip_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS vip_dispatched_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS vip_tracking_code text,
  ADD COLUMN IF NOT EXISTS vip_carrier text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_wholesale_fulfillment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_wholesale_fulfillment_status_check CHECK (
  wholesale_fulfillment_status IS NULL OR wholesale_fulfillment_status IN (
    'not_applicable', 'awaiting_supplier', 'supplier_preparing', 'supplier_dispatched', 'dispatched_to_kolbe',
    'arrived_at_kolbe', 'partially_received_at_kolbe', 'received_at_kolbe', 'receiving', 'under_inspection', 'under_qc',
    'partially_accepted', 'qc_issue', 'accepted', 'qc_passed', 'rejected',
    'awaiting_consolidation', 'consolidated', 'ready_for_vip', 'ready_for_vip_dispatch', 'vip_dispatched', 'delivered'
  )
);

CREATE SEQUENCE IF NOT EXISTS supplier_fulfillment_seq START 100000;
CREATE SEQUENCE IF NOT EXISTS inbound_shipment_seq START 100000;
CREATE SEQUENCE IF NOT EXISTS warehouse_receipt_seq START 100000;

CREATE TABLE IF NOT EXISTS supplier_fulfillments (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  destination_warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'awaiting_supplier' CHECK (
    status IN (
      'awaiting_supplier', 'supplier_preparing', 'supplier_dispatched', 'dispatched_to_kolbe',
      'arrived_at_kolbe', 'receiving', 'under_inspection', 'partially_accepted', 'qc_partially_accepted',
      'accepted', 'qc_passed', 'rejected', 'qc_rejected',
      'awaiting_consolidation', 'consolidated', 'ready_for_vip', 'vip_dispatched', 'delivered', 'cancelled'
    )
  ),
  notes text,
  dispatched_at timestamptz,
  arrived_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS supplier_fulfillments_order_idx ON supplier_fulfillments(order_id);
CREATE INDEX IF NOT EXISTS supplier_fulfillments_supplier_idx ON supplier_fulfillments(supplier_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_shipments (
  id uuid PRIMARY KEY,
  shipment_number text NOT NULL UNIQUE,
  supplier_fulfillment_id uuid NOT NULL REFERENCES supplier_fulfillments(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  destination_warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'supplier_dispatched' CHECK (
    status IN (
      'awaiting_supplier', 'supplier_preparing', 'supplier_dispatched', 'arrived_at_kolbe',
      'receiving', 'under_inspection', 'partially_accepted', 'accepted', 'rejected'
    )
  ),
  carrier text,
  tracking_code text,
  dispatched_at timestamptz,
  arrived_at timestamptz,
  inspected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_shipments_order_idx ON inbound_shipments(order_id, status);
CREATE INDEX IF NOT EXISTS inbound_shipments_supplier_idx ON inbound_shipments(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_shipments_warehouse_idx ON inbound_shipments(destination_warehouse_id, status);

CREATE TABLE IF NOT EXISTS inbound_shipment_lines (
  id uuid PRIMARY KEY,
  inbound_shipment_id uuid NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
  order_line_id uuid NOT NULL REFERENCES order_lines(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  expected_quantity integer NOT NULL CHECK (expected_quantity > 0),
  received_quantity integer NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  accepted_quantity integer NOT NULL DEFAULT 0 CHECK (accepted_quantity >= 0),
  rejected_quantity integer NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  damaged_quantity integer NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  missing_quantity integer NOT NULL DEFAULT 0 CHECK (missing_quantity >= 0),
  inspection_note text,
  inspected_by uuid REFERENCES users(id),
  inspected_at timestamptz,
  UNIQUE (inbound_shipment_id, order_line_id),
  CHECK (received_quantity + missing_quantity <= expected_quantity),
  CHECK (accepted_quantity + rejected_quantity + damaged_quantity <= received_quantity)
);

CREATE INDEX IF NOT EXISTS inbound_shipment_lines_shipment_idx ON inbound_shipment_lines(inbound_shipment_id);
CREATE INDEX IF NOT EXISTS inbound_shipment_lines_order_line_idx ON inbound_shipment_lines(order_line_id);

CREATE TABLE IF NOT EXISTS warehouse_receipts (
  id uuid PRIMARY KEY,
  receipt_number text NOT NULL UNIQUE,
  inbound_shipment_id uuid NOT NULL REFERENCES inbound_shipments(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  received_by uuid NOT NULL REFERENCES users(id),
  qc_status text NOT NULL DEFAULT 'accepted' CHECK (qc_status IN ('pending', 'accepted', 'partially_accepted', 'rejected')),
  notes text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warehouse_receipts_shipment_idx ON warehouse_receipts(inbound_shipment_id, qc_status);

-- 8. Unified Promotion Engine (Variant, Color, Size, Product, Category targeting)
CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY,
  code text UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'festival', 'campaign')),
  channel text NOT NULL DEFAULT 'retail' CHECK (channel IN ('retail', 'wholesale', 'all')),
  exclusive_policy text NOT NULL DEFAULT 'stackable_by_priority' CHECK (
    exclusive_policy IN ('stackable_by_priority', 'festival_exclusive', 'override_all')
  ),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS promotions_active_window_idx
  ON promotions(active, starts_at, ends_at) WHERE active = true;

CREATE TABLE IF NOT EXISTS promotion_rules (
  id uuid PRIMARY KEY,
  promotion_id uuid REFERENCES promotions(id) ON DELETE CASCADE,
  name text,
  channel text NOT NULL DEFAULT 'retail' CHECK (channel IN ('retail', 'wholesale', 'all')),
  target_type text NOT NULL CHECK (target_type IN ('product', 'color', 'size', 'variant', 'category')),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  color_id text,
  size_code text,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  category text,
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'fixed_rial')),
  discount_value bigint NOT NULL CHECK (discount_value > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'percent' OR (discount_value >= 1 AND discount_value <= 95)),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CHECK (
    (target_type = 'variant' AND variant_id IS NOT NULL) OR
    (target_type = 'color' AND product_id IS NOT NULL AND color_id IS NOT NULL AND length(trim(color_id)) > 0) OR
    (target_type = 'size' AND product_id IS NOT NULL AND size_code IS NOT NULL AND length(trim(size_code)) > 0) OR
    (target_type = 'product' AND product_id IS NOT NULL) OR
    (target_type = 'category' AND category IS NOT NULL AND length(trim(category)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS promotion_rules_variant_idx
  ON promotion_rules(variant_id, active) WHERE active = true AND target_type = 'variant';
CREATE INDEX IF NOT EXISTS promotion_rules_product_idx
  ON promotion_rules(product_id, target_type, active) WHERE active = true;
CREATE INDEX IF NOT EXISTS promotion_rules_promotion_idx
  ON promotion_rules(promotion_id) WHERE promotion_id IS NOT NULL;

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id),
  ADD COLUMN IF NOT EXISTS inventory_domain text NOT NULL DEFAULT 'retail'
    CHECK (inventory_domain IN ('retail', 'wholesale')),
  ADD COLUMN IF NOT EXISTS base_unit_price_rial bigint CHECK (base_unit_price_rial IS NULL OR base_unit_price_rial >= 0),
  ADD COLUMN IF NOT EXISTS discount_amount_rial bigint NOT NULL DEFAULT 0 CHECK (discount_amount_rial >= 0),
  ADD COLUMN IF NOT EXISTS applied_promotion_rule_id uuid REFERENCES promotion_rules(id),
  ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS supplier_fulfillment_id uuid REFERENCES supplier_fulfillments(id),
  ADD COLUMN IF NOT EXISTS received_at_kolbe timestamptz,
  ADD COLUMN IF NOT EXISTS qc_status text NOT NULL DEFAULT 'pending'
    CHECK (qc_status IN ('pending', 'accepted', 'partially_accepted', 'rejected'));

UPDATE order_lines ol
SET product_id = pv.product_id
FROM product_variants pv
WHERE ol.variant_id = pv.id
  AND ol.product_id IS NULL;

UPDATE order_lines SET base_unit_price_rial = unit_price_rial WHERE base_unit_price_rial IS NULL;
