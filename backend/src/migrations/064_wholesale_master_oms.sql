-- 064 — Prompt 2: VIP Wholesale Master/Child OMS (additive, reversible, data-safe).
--
-- Design (§17-§20): the existing `orders` table REMAINS the financial/legal unit and
-- becomes the CHILD ORDER (one per seller). A thin `master_orders` aggregation row
-- groups the children of one VIP purchase for consolidation/shipment only — it is
-- NEVER financial truth. Legacy orders keep master_order_id NULL (legacy
-- read-compatible mode §155); nothing existing is rewritten.

-- ---------- sequences ----------
CREATE SEQUENCE IF NOT EXISTS master_order_seq START 2000;
CREATE SEQUENCE IF NOT EXISTS consolidation_seq START 4000;

-- ---------- master orders (§18-§20) ----------
CREATE TABLE IF NOT EXISTS master_orders (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,                 -- MV-{seq}
  buyer_id uuid NOT NULL REFERENCES users(id),
  -- §41: composition lifecycle — children can be added/removed only while OPEN.
  composition text NOT NULL DEFAULT 'open' CHECK (composition IN ('open', 'locked')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_method_id uuid,
  -- §111-§113: estimate while open, snapshot at lock.
  shipping_estimate_rial bigint CHECK (shipping_estimate_rial IS NULL OR shipping_estimate_rial >= 0),
  shipping_quote_snapshot jsonb,
  locked_at timestamptz,
  locked_by uuid REFERENCES users(id),
  -- §103: ONE master-level final shipment in V1.
  carrier text,
  tracking_code text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS master_orders_buyer_idx ON master_orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS master_orders_status_idx ON master_orders(status, composition);

-- ---------- child-order columns on orders (§18: reuse, no parallel OMS) ----------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS master_order_id uuid REFERENCES master_orders(id),
  ADD COLUMN IF NOT EXISTS seller_type text CHECK (seller_type IN ('kolbe', 'supplier')),
  ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES users(id),
  -- §73: supply status domain (children only; NULL = legacy/retail order).
  ADD COLUMN IF NOT EXISTS supply_status text CHECK (supply_status IN (
    'unresolved', 'stock_reserved', 'awaiting_supplier', 'partially_confirmed',
    'awaiting_buyer', 'confirmed', 'rejected', 'timed_out', 'exception')),
  -- §46: payment eligibility domain — the HARD server gate before any intent.
  ADD COLUMN IF NOT EXISTS payment_eligibility text CHECK (payment_eligibility IN (
    'not_ready', 'blocked_supply_pending', 'blocked_buyer_decision', 'ready',
    'expired', 'blocked_exception', 'paid')),
  ADD COLUMN IF NOT EXISTS payment_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS supplier_respond_by timestamptz,
  -- §75: child fulfillment domain, separate from legacy wholesale_fulfillment_status.
  ADD COLUMN IF NOT EXISTS child_fulfillment text CHECK (child_fulfillment IN (
    'not_started', 'waiting_payment', 'preparing', 'dispatched', 'in_transit',
    'received', 'qc_pending', 'qc_partial', 'qc_failed', 'ready_for_consolidation',
    'consolidated', 'exception', 'delivered')),
  -- §43/§44: membership of the child inside the master consolidation denominator.
  ADD COLUMN IF NOT EXISTS composition_state text CHECK (composition_state IN (
    'included', 'removed', 'cancel_refund_pending', 'cancelled'));
CREATE INDEX IF NOT EXISTS orders_master_idx ON orders(master_order_id) WHERE master_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_seller_idx ON orders(seller_id, created_at DESC) WHERE seller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_payment_due_idx ON orders(payment_due_at)
  WHERE payment_eligibility IN ('ready', 'not_ready', 'blocked_supply_pending', 'blocked_buyer_decision');
CREATE INDEX IF NOT EXISTS orders_supplier_respond_idx ON orders(supplier_respond_by)
  WHERE supply_status IN ('awaiting_supplier', 'partially_confirmed');

-- ---------- commercial child lines (SERIES level, §21-§24) ----------
-- Complements piece-level order_lines (kept for WMS/invoice compatibility):
-- this is the commercial/negotiation truth per (child, series template).
CREATE TABLE IF NOT EXISTS child_order_lines (
  id uuid PRIMARY KEY,
  master_order_id uuid NOT NULL REFERENCES master_orders(id) ON DELETE RESTRICT,
  child_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id),
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  offer_id uuid REFERENCES supplier_offers(id),
  seller_type text NOT NULL CHECK (seller_type IN ('kolbe', 'supplier')),
  seller_id uuid REFERENCES users(id),
  -- §35: requested vs proposed vs confirmed are IMMUTABLE history fields.
  requested_series integer NOT NULL CHECK (requested_series > 0),
  proposed_series integer CHECK (proposed_series IS NULL OR proposed_series >= 0),
  confirmed_series integer CHECK (confirmed_series IS NULL OR confirmed_series >= 0),
  -- §91: settlement-grade quantity trace (updated by fulfillment, never silently).
  accepted_series integer CHECK (accepted_series IS NULL OR accepted_series >= 0),
  dispatched_series integer NOT NULL DEFAULT 0 CHECK (dispatched_series >= 0),
  received_series integer NOT NULL DEFAULT 0 CHECK (received_series >= 0),
  qc_passed_series integer NOT NULL DEFAULT 0 CHECK (qc_passed_series >= 0),
  qc_rejected_series integer NOT NULL DEFAULT 0 CHECK (qc_rejected_series >= 0),
  pieces_per_series integer NOT NULL CHECK (pieces_per_series > 0),
  unit_series_price_rial bigint NOT NULL CHECK (unit_series_price_rial >= 0),
  line_total_rial bigint NOT NULL CHECK (line_total_rial >= 0),
  -- §66: commercial snapshot frozen before READY; immutable afterwards (service-enforced).
  commercial_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_locked_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'stock_reserved', 'awaiting_supplier', 'confirmed', 'counter_offered',
    'awaiting_buyer', 'accepted', 'rejected', 'removed', 'timed_out', 'exception')),
  responded_at timestamptz,
  decided_at timestamptz,
  -- §35: append-only negotiation audit (requested/proposed/decision steps).
  negotiation_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS child_order_lines_child_idx ON child_order_lines(child_order_id);
CREATE INDEX IF NOT EXISTS child_order_lines_master_idx ON child_order_lines(master_order_id);
CREATE INDEX IF NOT EXISTS child_order_lines_seller_idx ON child_order_lines(seller_id, status)
  WHERE seller_id IS NOT NULL;

-- ---------- per-line source allocations (§21-§27) ----------
CREATE TABLE IF NOT EXISTS order_source_allocations (
  id uuid PRIMARY KEY,
  line_id uuid NOT NULL REFERENCES child_order_lines(id) ON DELETE RESTRICT,
  child_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  master_order_id uuid NOT NULL REFERENCES master_orders(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN (
    'kolbe_stock', 'supplier_stock_at_kolbe', 'supplier_external')),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'reserved', 'released', 'consumed', 'expired', 'cancelled', 'exception')),
  warehouse_id uuid REFERENCES warehouses(id),
  owner_supplier_id uuid REFERENCES users(id),
  offer_id uuid REFERENCES supplier_offers(id),
  -- §33: external capacity reservation handle (Prompt-1 primitive) — NEVER kolbe stock.
  capacity_reservation_id uuid REFERENCES supplier_capacity_reservations(id),
  reservation_expires_at timestamptz,
  -- §83/§86: order-bound external goods NEVER become general stock-at-kolbe.
  disposition text NOT NULL DEFAULT 'general' CHECK (disposition IN ('general', 'order_bound')),
  dispatched_series integer NOT NULL DEFAULT 0 CHECK (dispatched_series >= 0),
  received_series integer NOT NULL DEFAULT 0 CHECK (received_series >= 0),
  qc_passed_series integer NOT NULL DEFAULT 0 CHECK (qc_passed_series >= 0),
  qc_rejected_series integer NOT NULL DEFAULT 0 CHECK (qc_rejected_series >= 0),
  reserved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_source_allocations_line_idx ON order_source_allocations(line_id);
CREATE INDEX IF NOT EXISTS order_source_allocations_child_idx ON order_source_allocations(child_order_id, status);
CREATE INDEX IF NOT EXISTS order_source_allocations_expiry_idx ON order_source_allocations(reservation_expires_at)
  WHERE status = 'reserved';

-- ---------- batch payment (§57-§60) ----------
-- Relax the exactly-one target CHECK: batch intents carry NEITHER order_id NOR
-- membership_id — their targets live in payment_allocations. Single-target intents
-- keep working unchanged (legacy constraint becomes "at most one").
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'payment_intents'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%membership_id%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE payment_intents DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_target_check
  CHECK ((order_id IS NOT NULL)::integer + (membership_id IS NOT NULL)::integer <= 1);
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS master_order_id uuid REFERENCES master_orders(id),
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'order'
    CHECK (purpose IN ('order', 'membership', 'child_order', 'child_batch'));

CREATE TABLE IF NOT EXISTS payment_allocations (
  id uuid PRIMARY KEY,
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  child_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_rial bigint NOT NULL CHECK (amount_rial > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'succeeded', 'failed', 'cancelled', 'exception')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_intent_id, child_order_id)
);
-- §143: at most ONE active (pending) intent allocation per child order.
CREATE UNIQUE INDEX IF NOT EXISTS payment_allocations_active_child_uniq
  ON payment_allocations(child_order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payment_allocations_intent_idx ON payment_allocations(payment_intent_id);

-- ---------- consolidation (§93-§102) ----------
CREATE TABLE IF NOT EXISTS master_consolidations (
  id uuid PRIMARY KEY,
  master_order_id uuid NOT NULL UNIQUE REFERENCES master_orders(id) ON DELETE RESTRICT,
  reference text NOT NULL UNIQUE,                 -- CON-{seq}
  status text NOT NULL DEFAULT 'started' CHECK (status IN (
    'started', 'consolidated', 'packed', 'ready_for_shipment', 'shipped')),
  expected_children integer NOT NULL DEFAULT 0 CHECK (expected_children >= 0),
  started_by uuid REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  consolidated_at timestamptz,
  packed_at timestamptz,
  packed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consolidation_items (
  id uuid PRIMARY KEY,
  consolidation_id uuid NOT NULL REFERENCES master_consolidations(id) ON DELETE RESTRICT,
  child_order_id uuid NOT NULL REFERENCES orders(id),
  line_id uuid NOT NULL REFERENCES child_order_lines(id),
  series_template_id uuid NOT NULL REFERENCES series_templates(id),
  expected_series integer NOT NULL CHECK (expected_series >= 0),
  verified_series integer NOT NULL DEFAULT 0 CHECK (verified_series >= 0),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  -- §97: duplicate scan of the same line is rejected by this uniqueness.
  UNIQUE (consolidation_id, line_id)
);
CREATE INDEX IF NOT EXISTS consolidation_items_child_idx ON consolidation_items(child_order_id);

-- ---------- fulfillment exceptions (§88-§90) ----------
CREATE TABLE IF NOT EXISTS fulfillment_exceptions (
  id uuid PRIMARY KEY,
  master_order_id uuid REFERENCES master_orders(id),
  child_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  line_id uuid REFERENCES child_order_lines(id),
  allocation_id uuid REFERENCES order_source_allocations(id),
  exception_type text NOT NULL CHECK (exception_type IN (
    'shortage', 'damaged', 'qc_rejected', 'wrong_product', 'wrong_variant',
    'wrong_series', 'supplier_late', 'lost_inbound', 'payment_late_callback')),
  quantity integer CHECK (quantity IS NULL OR quantity > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  resolution text,
  -- §90: finance resolution refs only — actual refund/settlement money flows are Prompt 3.
  resolution_reference jsonb,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fulfillment_exceptions_child_idx ON fulfillment_exceptions(child_order_id, status);
CREATE INDEX IF NOT EXISTS fulfillment_exceptions_master_idx ON fulfillment_exceptions(master_order_id)
  WHERE master_order_id IS NOT NULL;

-- ---------- configurable OMS policy (§47/§69: TTLs are settings, not hardcoded) ----------
INSERT INTO site_settings(key, value)
VALUES ('wholesale_oms_policy', '{"paymentTtlMinutes": 2880, "physicalReservationTtlMinutes": 2880, "externalReservationTtlMinutes": 2880, "supplierRespondHours": 48}'::jsonb)
ON CONFLICT (key) DO NOTHING;
