-- Prompt 5 — supplier response, commitment, readiness and durable OMS-linked capacity.
-- These fields extend the existing OMS line/allocation rows; they are not a second request or order system.
ALTER TABLE child_order_lines
  ADD COLUMN IF NOT EXISTS supplier_response_status text NOT NULL DEFAULT 'unanswered'
    CHECK (supplier_response_status IN ('unanswered','accepted','revised','rejected','committed','ready','cancelled')),
  ADD COLUMN IF NOT EXISTS supplier_response_note text,
  ADD COLUMN IF NOT EXISTS supplier_responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supplier_committed_series integer NOT NULL DEFAULT 0 CHECK (supplier_committed_series >= 0),
  ADD COLUMN IF NOT EXISTS supplier_committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS supplier_ready_at timestamptz;

-- Backfill the already-canonical OMS state without manufacturing WMS movements or stock.
UPDATE child_order_lines
   SET supplier_response_status = CASE
         WHEN status = 'confirmed' THEN 'committed'
         WHEN status = 'awaiting_buyer' THEN 'revised'
         WHEN status = 'rejected' THEN 'rejected'
         ELSE 'unanswered'
       END,
       supplier_responded_at = COALESCE(responded_at, updated_at),
       supplier_committed_series = CASE WHEN status = 'confirmed' THEN COALESCE(confirmed_series, requested_series) ELSE 0 END,
       supplier_committed_at = CASE WHEN status = 'confirmed' THEN COALESCE(responded_at, updated_at) ELSE NULL END
 WHERE seller_type = 'supplier'
   AND supplier_response_status = 'unanswered'
   AND status IN ('confirmed','awaiting_buyer','rejected');

-- Supplier commitments attached to the canonical order allocation are durable until an OMS-owned
-- payment-expiry/cancellation/reassignment/fulfillment transition explicitly resolves them. The
-- generic supplier-capacity TTL sweep must never release these rows by itself.
UPDATE supplier_capacity_reservations r
   SET expires_at = NULL, updated_at = now()
  FROM order_source_allocations a
 WHERE a.capacity_reservation_id = r.id
   AND a.source_type = 'supplier_external'
   AND a.status = 'reserved'
   AND r.status = 'active'
   AND r.reference_type = 'order_source_allocation';

CREATE INDEX IF NOT EXISTS child_order_lines_supplier_response_idx
  ON child_order_lines(seller_id, supplier_response_status, updated_at)
  WHERE seller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_source_allocations_supplier_demand_idx
  ON order_source_allocations(owner_supplier_id, status, created_at)
  WHERE source_type = 'supplier_external' AND owner_supplier_id IS NOT NULL;
