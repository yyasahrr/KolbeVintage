-- 062: Series becomes a REAL inventory unit + warehouse purpose + manual-order channel
--      + variant-level retail sale eligibility (Local QA Corrections scope).
--
-- Final business model:
--   CENTRAL WHOLESALE WAREHOUSE → unit = SERIES (kolbe-owned + supplier-owned, ownership explicit)
--   RETAIL WAREHOUSE            → unit = PIECE
--
-- Overlay model (NO parallel product/series system):
--   * series_templates / series_template_items stay the recipe source of truth (migration 060).
--   * series_stock_balances adds the EXPLICIT intact-series state (on_hand/reserved/incoming/damaged).
--   * variant-level stock_balances remain the piece bookkeeping of the same physical goods;
--     intact series are a "banding" of those pieces, so recipe×series_on_hand must stay coverable
--     by component stock. Operations enforce this at write time (backend, not UI).
--   * NO blind inference: existing wholesale variant balances are NOT fabricated into intact
--     series. Explicit rows start empty; admins declare real counts via the audited stocktake
--     endpoint, and a reconciliation report lists templates still running on the legacy
--     component-derived availability.

-- ---------- §39: warehouse purpose ----------
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'mixed';
ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_purpose_check;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_purpose_check CHECK (purpose IN ('retail', 'wholesale', 'mixed'));

-- Deterministic backfill from REAL stock domains (no guessing):
--   wholesale-only balances → wholesale; retail-only → retail; both/none → mixed (legacy,
--   reported by the reconciliation endpoint for the admin to settle in warehouse settings).
UPDATE warehouses w SET purpose = 'wholesale'
WHERE purpose = 'mixed'
  AND EXISTS (SELECT 1 FROM stock_balances b WHERE b.warehouse_id = w.id AND b.inventory_domain = 'wholesale' AND (b.on_hand > 0 OR b.incoming > 0))
  AND NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.warehouse_id = w.id AND b.inventory_domain = 'retail' AND (b.on_hand > 0 OR b.incoming > 0));
UPDATE warehouses w SET purpose = 'retail'
WHERE purpose = 'mixed'
  AND EXISTS (SELECT 1 FROM stock_balances b WHERE b.warehouse_id = w.id AND b.inventory_domain = 'retail' AND (b.on_hand > 0 OR b.incoming > 0))
  AND NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.warehouse_id = w.id AND b.inventory_domain = 'wholesale' AND (b.on_hand > 0 OR b.incoming > 0));

-- ---------- §5: series recipe is color-aware ----------
ALTER TABLE series_templates ADD COLUMN IF NOT EXISTS color_label text;
-- Deterministic backfill: templates whose components all share ONE color get that color;
-- mixed-color legacy templates stay NULL (flagged by the reconciliation report).
UPDATE series_templates t SET color_label = sub.color_label
FROM (
  SELECT i.series_template_id, min(v.color_label) AS color_label
  FROM series_template_items i JOIN product_variants v ON v.id = i.variant_id
  GROUP BY i.series_template_id
  HAVING count(DISTINCT COALESCE(v.color_label, '∅')) = 1 AND min(v.color_label) IS NOT NULL
) sub
WHERE sub.series_template_id = t.id AND t.color_label IS NULL;

-- ---------- §4: explicit intact-series stock ----------
CREATE TABLE IF NOT EXISTS series_stock_balances (
  id uuid PRIMARY KEY,
  series_template_id uuid NOT NULL REFERENCES series_templates(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  owner_type text NOT NULL DEFAULT 'kolbe' CHECK (owner_type IN ('kolbe', 'supplier')),
  supplier_id uuid REFERENCES users(id),
  on_hand integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  incoming integer NOT NULL DEFAULT 0 CHECK (incoming >= 0),
  damaged integer NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved <= on_hand),
  CHECK ((owner_type = 'supplier') = (supplier_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS series_stock_balances_uniq
  ON series_stock_balances (series_template_id, warehouse_id, owner_type, COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS series_stock_balances_wh_idx ON series_stock_balances (warehouse_id);

-- ---------- §44: append-only series movement ledger ----------
CREATE TABLE IF NOT EXISTS series_stock_movements (
  id uuid PRIMARY KEY,
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  owner_type text NOT NULL DEFAULT 'kolbe' CHECK (owner_type IN ('kolbe', 'supplier')),
  supplier_id uuid REFERENCES users(id),
  movement_type text NOT NULL CHECK (movement_type IN (
    'stocktake', 'receipt', 'reserve', 'release', 'consume', 'dispatch_break',
    'incoming', 'incoming_receive', 'incoming_cancel', 'qc_reject', 'adjust'
  )),
  quantity integer NOT NULL CHECK (quantity <> 0),
  recipe_snapshot jsonb,
  reference_type text,
  reference_id uuid,
  note text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES users(id),
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS series_stock_movements_tpl_idx ON series_stock_movements (series_template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS series_stock_movements_ref_idx ON series_stock_movements (reference_type, reference_id);

-- ---------- §36: wholesale orders reserve intact series ----------
CREATE TABLE IF NOT EXISTS order_series_reservations (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  owner_type text NOT NULL DEFAULT 'kolbe' CHECK (owner_type IN ('kolbe', 'supplier')),
  supplier_id uuid REFERENCES users(id),
  series_count integer NOT NULL CHECK (series_count > 0),
  recipe_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_series_reservations_order_idx ON order_series_reservations (order_id, status);

-- ---------- §15: retail supply (break series) document ----------
CREATE SEQUENCE IF NOT EXISTS retail_supply_seq START 1000;
CREATE TABLE IF NOT EXISTS retail_supply_orders (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  product_id uuid NOT NULL REFERENCES products(id),
  product_name text NOT NULL,
  color_label text,
  source_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  destination_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  series_count integer NOT NULL CHECK (series_count > 0 AND series_count <= 500),
  pieces_total integer NOT NULL CHECK (pieces_total > 0),
  -- §6: composition snapshot — future recipe edits must never reinterpret this document.
  recipe_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'dispatched', 'received', 'cancelled')),
  idempotency_key text UNIQUE,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS retail_supply_orders_status_idx ON retail_supply_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS retail_supply_events (
  id uuid PRIMARY KEY,
  supply_id uuid NOT NULL REFERENCES retail_supply_orders(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  note text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retail_supply_events_supply_idx ON retail_supply_events (supply_id, created_at);

-- ---------- §22/§32: sales channel on the canonical order ----------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel text NOT NULL DEFAULT 'website';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_sales_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_sales_channel_check CHECK (
  sales_channel IN ('website', 'instagram', 'in_person', 'phone', 'whatsapp', 'telegram', 'other')
);
-- §37: order-level series snapshot column (was audit-only before).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS series_snapshot jsonb;

-- ---------- §29: explicit variant-level retail sale eligibility ----------
-- product.retail_enabled stays the master switch; this is the per-variant switch.
-- variant.active keeps meaning "variant exists/visible" and is NOT abused as sale status.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS retail_sale_enabled boolean NOT NULL DEFAULT true;
