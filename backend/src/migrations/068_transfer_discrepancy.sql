-- §17.4 / QA2-WMS-013: destination receipt with discrepancy.
-- A transfer of 20 units may arrive as 18 healthy + 2 damaged; the receipt must
-- record per-line received/damaged quantities and flag the transfer document.

ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'approved', 'in_transit', 'completed', 'completed_with_discrepancy', 'cancelled'));

-- Mode A (single-variant transfers carry quantity on the header).
ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS received_qty integer CHECK (received_qty IS NULL OR received_qty >= 0),
  ADD COLUMN IF NOT EXISTS damaged_qty integer CHECK (damaged_qty IS NULL OR damaged_qty >= 0);

-- Mode B (multi-line WMS transfers carry quantities on lines).
ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS received_qty integer CHECK (received_qty IS NULL OR received_qty >= 0),
  ADD COLUMN IF NOT EXISTS damaged_qty integer CHECK (damaged_qty IS NULL OR damaged_qty >= 0);
