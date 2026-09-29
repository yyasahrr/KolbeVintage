-- WMS completion + Wishlist + Returns + Addresses (steps 2,7,8,9)
-- Warehouses / Locations / Stock flows already in 001, extend with locations & transfer/receipt/return

CREATE TABLE warehouse_locations (
  id uuid PRIMARY KEY,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code)
);
CREATE INDEX warehouse_locations_warehouse_idx ON warehouse_locations(warehouse_id);

CREATE TABLE stock_receipts (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('pending','received','cancelled')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz
);
CREATE INDEX stock_receipts_warehouse_idx ON stock_receipts(warehouse_id, created_at DESC);

CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  from_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  to_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_transit','completed','cancelled')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity integer NOT NULL CHECK (quantity > 0)
);
CREATE INDEX stock_transfer_lines_transfer_idx ON stock_transfer_lines(transfer_id);

-- Wishlist: multiple lists/collections per user, brand/product save, price drop / restock alerts
CREATE TABLE wishlist_collections (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wishlist_collections_owner_idx ON wishlist_collections(owner_id);

CREATE TABLE wishlist_items (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES wishlist_collections(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  price_at_add bigint CHECK (price_at_add IS NULL OR price_at_add >= 0),
  UNIQUE (collection_id, product_id, variant_id)
);
CREATE INDEX wishlist_items_collection_idx ON wishlist_items(collection_id);
CREATE INDEX wishlist_items_product_idx ON wishlist_items(product_id);

CREATE TABLE wishlist_alerts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('price_drop','restock','back_in_stock')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id, kind)
);

-- Customer addresses (step 9)
CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  recipient text NOT NULL,
  phone varchar(20) NOT NULL,
  province text NOT NULL,
  city text NOT NULL,
  line text NOT NULL,
  postal_code varchar(10) NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_user_idx ON customer_addresses(user_id);

-- Return requests with inspection -> sellable/damaged (step 2)
CREATE TABLE return_requests (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  order_line_id uuid REFERENCES order_lines(id),
  requester_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','received','refunded','rejected')),
  resolution text NOT NULL CHECK (resolution IN ('refund','exchange','credit')),
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  inspection_result text CHECK (inspection_result IN ('sellable','damaged')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_requests_order_idx ON return_requests(order_id);
CREATE INDEX return_requests_requester_idx ON return_requests(requester_id);

-- Extend audit trail permissions
INSERT INTO permissions(code, title) VALUES
  ('inventory:read', 'مشاهده موجودی'),
  ('inventory:adjust', 'اصلاح موجودی'),
  ('inventory:transfer', 'انتقال موجودی'),
  ('wishlist:manage', 'مدیریت لیست علاقه‌مندی'),
  ('addresses:manage', 'مدیریت آدرس‌ها'),
  ('returns:manage', 'مدیریت مرجوعی‌ها')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'inventory:read'), ('admin', 'inventory:adjust'), ('admin', 'inventory:transfer'),
  ('admin', 'wishlist:manage'), ('admin', 'addresses:manage'), ('admin', 'returns:manage'),
  ('operations', 'inventory:read'), ('operations', 'inventory:adjust'), ('operations', 'inventory:transfer'),
  ('support', 'returns:manage')
ON CONFLICT DO NOTHING;

-- Sequence for transfer/receipt references
CREATE SEQUENCE transfer_reference_seq START 200000;
CREATE SEQUENCE receipt_reference_seq START 300000;
