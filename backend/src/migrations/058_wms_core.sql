-- 058: WMS core hardening — receipt discrepancy capture + reverse transfers + batch references.
-- Rerun-safe: only additive ALTERs with IF NOT EXISTS.

-- R. Receipt discrepancy: expected vs actually received quantities must be recordable,
-- never silently confirmed.
ALTER TABLE stock_receipts
  ADD COLUMN IF NOT EXISTS received_quantity integer CHECK (received_quantity IS NULL OR received_quantity >= 0),
  ADD COLUMN IF NOT EXISTS missing_quantity integer NOT NULL DEFAULT 0 CHECK (missing_quantity >= 0),
  ADD COLUMN IF NOT EXISTS batch_reference text,
  ADD COLUMN IF NOT EXISTS supplier_request_id uuid;

-- H. Reverse transfers: completed transfers are immutable; corrections flow through
-- a dedicated reverse transfer referencing the original (TRF-100 -> RTRF-100).
ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS original_transfer_id uuid REFERENCES stock_transfers(id),
  ADD COLUMN IF NOT EXISTS is_reverse boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_quantity integer NOT NULL DEFAULT 0 CHECK (reversed_quantity >= 0),
  ADD COLUMN IF NOT EXISTS batch_reference text;

CREATE INDEX IF NOT EXISTS stock_transfers_original_idx ON stock_transfers(original_transfer_id) WHERE original_transfer_id IS NOT NULL;
