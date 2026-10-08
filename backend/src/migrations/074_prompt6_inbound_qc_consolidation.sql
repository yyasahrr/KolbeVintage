-- 074 — Prompt 6: Inbound Operations / Warehouse Receiving (GRN) / QC / Consolidation / Final Shipment.
--
-- Design rules honoured here (see docs/parallel/prompt-6-...-report.md §Existing audit):
--   * NO parallel InboundV2 / WMSV2 / OMSV2. Everything below EXTENDS the canonical Prompt 1-5 schema.
--   * Quantities stay single-authority: for order-bound external supply the ONLY quantity truth is
--     `order_source_allocations`. `oms_inbound_shipments` is a pure LIFECYCLE document (reference,
--     carrier, tracking, dates, status) and deliberately stores NO quantities, so the two can never drift.
--   * The existing `warehouse_receipts` table remains the ONE Goods-Received-Note (GRN) authority; it
--     gains an OMS scope alongside the legacy shipment scope instead of a second receipts table.
--   * All statements are additive and safe on populated databases (no destructive rewrite, no data loss).

-- ---------------------------------------------------------------------------------------------
-- 1. OMS-bound inbound shipment document (external supplier → Kolbe, order-bound legs).
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS oms_inbound_seq START 1000;

CREATE TABLE IF NOT EXISTS oms_inbound_shipments (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,                       -- OIN-{seq} — operator-facing, no UUIDs in UI
  master_order_id uuid NOT NULL REFERENCES master_orders(id) ON DELETE RESTRICT,
  child_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  destination_warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  -- §7 lifecycle. Legacy naming is avoided on purpose: these are the OMS-bound operational stages.
  status text NOT NULL DEFAULT 'dispatched' CHECK (status IN (
    'dispatched', 'in_transit', 'arrived', 'receiving', 'received', 'qc_completed', 'cancelled'
  )),
  carrier text,
  tracking_code text,
  note text NOT NULL DEFAULT '',
  dispatched_at timestamptz,
  arrived_at timestamptz,
  receiving_started_at timestamptz,
  received_at timestamptz,
  qc_completed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oms_inbound_shipments_status_idx ON oms_inbound_shipments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS oms_inbound_shipments_warehouse_idx ON oms_inbound_shipments(destination_warehouse_id, status);
CREATE INDEX IF NOT EXISTS oms_inbound_shipments_supplier_idx ON oms_inbound_shipments(supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oms_inbound_shipments_child_idx ON oms_inbound_shipments(child_order_id);

-- At most ONE live (non-terminal) inbound leg per (child order, supplier). A re-dispatch after an
-- authorised `supplier_redelivery` resolution creates a NEW leg only once the previous one reached a
-- terminal stage — so the same physical dispatch can never be tracked twice at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS oms_inbound_shipments_live_uniq
  ON oms_inbound_shipments(child_order_id, supplier_id)
  WHERE status NOT IN ('qc_completed', 'cancelled');

-- ---------------------------------------------------------------------------------------------
-- 2. Receiving / QC detail on the allocation (the single quantity authority for order-bound goods).
--    Buckets are MUTUALLY EXCLUSIVE (see report §Quantity reconciliation):
--      dispatched = received + missing          (once the receive scope is reconciled)
--      received   = qc_passed + qc_rejected + qc_damaged + pending_inspection
--    "damaged" is its own bucket, never a subset of rejected — so the same unit can never be
--    counted twice as damaged AND missing AND rejected.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE order_source_allocations
  ADD COLUMN IF NOT EXISTS inbound_shipment_id uuid REFERENCES oms_inbound_shipments(id),
  ADD COLUMN IF NOT EXISTS received_missing_series integer NOT NULL DEFAULT 0 CHECK (received_missing_series >= 0),
  ADD COLUMN IF NOT EXISTS received_damaged_series integer NOT NULL DEFAULT 0 CHECK (received_damaged_series >= 0),
  ADD COLUMN IF NOT EXISTS qc_damaged_series integer NOT NULL DEFAULT 0 CHECK (qc_damaged_series >= 0),
  ADD COLUMN IF NOT EXISTS receipt_note text,
  ADD COLUMN IF NOT EXISTS qc_note text,
  ADD COLUMN IF NOT EXISTS received_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS qc_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS qc_at timestamptz;

CREATE INDEX IF NOT EXISTS order_source_allocations_inbound_idx
  ON order_source_allocations(inbound_shipment_id) WHERE inbound_shipment_id IS NOT NULL;

-- Server-side reconciliation guards (authoritative, not frontend arithmetic).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_source_allocations_receipt_buckets_check') THEN
    ALTER TABLE order_source_allocations ADD CONSTRAINT order_source_allocations_receipt_buckets_check
      CHECK (received_series + received_missing_series <= dispatched_series);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_source_allocations_qc_buckets_check') THEN
    ALTER TABLE order_source_allocations ADD CONSTRAINT order_source_allocations_qc_buckets_check
      CHECK (qc_passed_series + qc_rejected_series + qc_damaged_series <= received_series);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. GRN: `warehouse_receipts` keeps ONE receipts authority and gains an OMS scope.
--    Exactly one of (legacy inbound_shipment_id, oms_inbound_shipment_id) is set.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE warehouse_receipts
  ALTER COLUMN inbound_shipment_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS oms_inbound_shipment_id uuid REFERENCES oms_inbound_shipments(id),
  ADD COLUMN IF NOT EXISTS shortage_series integer NOT NULL DEFAULT 0 CHECK (shortage_series >= 0),
  ADD COLUMN IF NOT EXISTS damaged_series integer NOT NULL DEFAULT 0 CHECK (damaged_series >= 0),
  ADD COLUMN IF NOT EXISTS inspected_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS inspected_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_receipts_scope_check') THEN
    ALTER TABLE warehouse_receipts ADD CONSTRAINT warehouse_receipts_scope_check
      CHECK ((inbound_shipment_id IS NOT NULL)::int + (oms_inbound_shipment_id IS NOT NULL)::int = 1);
  END IF;
END $$;

-- One GRN row per OMS inbound shipment: duplicate receiving is impossible at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_receipts_oms_shipment_uniq
  ON warehouse_receipts(oms_inbound_shipment_id) WHERE oms_inbound_shipment_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Consolidation verification + packing metadata (no fabricated weight/dimensions: NULL until an
--    operator records a real value).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE consolidation_items
  ADD COLUMN IF NOT EXISTS scan_reference text;
CREATE INDEX IF NOT EXISTS consolidation_items_consolidation_idx ON consolidation_items(consolidation_id);

ALTER TABLE master_consolidations
  ADD COLUMN IF NOT EXISTS package_count integer CHECK (package_count IS NULL OR package_count > 0),
  ADD COLUMN IF NOT EXISTS total_series integer CHECK (total_series IS NULL OR total_series >= 0),
  ADD COLUMN IF NOT EXISTS total_pieces integer CHECK (total_pieces IS NULL OR total_pieces >= 0),
  ADD COLUMN IF NOT EXISTS weight_grams bigint CHECK (weight_grams IS NULL OR weight_grams > 0),
  ADD COLUMN IF NOT EXISTS dimensions text,
  ADD COLUMN IF NOT EXISTS packaging_note text;

-- ---------------------------------------------------------------------------------------------
-- 5. Exception centre: operational exception kinds + responsible operator.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE fulfillment_exceptions DROP CONSTRAINT IF EXISTS fulfillment_exceptions_exception_type_check;
ALTER TABLE fulfillment_exceptions ADD CONSTRAINT fulfillment_exceptions_exception_type_check
  CHECK (exception_type IN (
    'shortage', 'damaged', 'qc_rejected', 'wrong_product', 'wrong_variant',
    'wrong_series', 'supplier_late', 'lost_inbound', 'payment_late_callback',
    'over_receipt', 'incorrect_quantity', 'reconciliation_failed',
    'delayed_inbound', 'supplier_non_fulfillment', 'wrong_master_order'
  ));

ALTER TABLE fulfillment_exceptions
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS fulfillment_exceptions_open_idx
  ON fulfillment_exceptions(status, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS fulfillment_exceptions_type_idx
  ON fulfillment_exceptions(exception_type, status);

-- ---------------------------------------------------------------------------------------------
-- 6. Operational policy for Prompt 6 (delay thresholds used by the dashboard/exception centre).
--    Configurable setting, never a hardcoded rule (§47/§69 convention from migration 064).
-- ---------------------------------------------------------------------------------------------
INSERT INTO site_settings(key, value)
VALUES ('wms_inbound_policy', '{"inboundDelayHours": 72}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 7. Granular warehouse duties (§27 — the SERVER decides allowed operations, never the UI).
--    These are ADDITIONAL duties on top of the existing `wholesale:ops` gate: a user keeps their
--    current access and can be narrowed to e.g. receiving-only or QC-only. `admin` receives them
--    automatically by the established rule "admin holds every permission".
-- ---------------------------------------------------------------------------------------------
INSERT INTO permissions(code, title) VALUES
  ('wms:receive', 'دریافت فیزیکی محموله ورودی'),
  ('wms:qc', 'کنترل کیفیت محموله ورودی'),
  ('wms:consolidate', 'تجمیع، بازبینی و بسته‌بندی سفارش مادر'),
  ('wms:ship', 'ارسال نهایی سفارش مادر از انبار کلبه')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code)
  SELECT 'admin', code FROM permissions WHERE code IN ('wms:receive', 'wms:qc', 'wms:consolidate', 'wms:ship')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('operations', 'wms:receive'), ('operations', 'wms:qc'),
  ('operations', 'wms:consolidate'), ('operations', 'wms:ship')
ON CONFLICT DO NOTHING;

