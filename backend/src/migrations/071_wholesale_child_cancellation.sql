-- Prompt 4 (§30-§31): a cancelled VIP child needs an HONEST fulfillment state.
-- The canonical column could previously express only operational progress (or NULL), so a cancelled
-- child either kept a stale progress value ("awaiting_supplier") or had to be lied about as 'rejected'.
-- This is a strictly additive widening of the allowed value list — no data rewrite, no table rebuild.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_wholesale_fulfillment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_wholesale_fulfillment_status_check CHECK (
  wholesale_fulfillment_status IS NULL OR wholesale_fulfillment_status IN (
    'not_applicable', 'awaiting_supplier', 'supplier_preparing', 'supplier_dispatched', 'dispatched_to_kolbe',
    'arrived_at_kolbe', 'partially_received_at_kolbe', 'received_at_kolbe', 'receiving', 'under_inspection', 'under_qc',
    'partially_accepted', 'qc_issue', 'accepted', 'qc_passed', 'rejected',
    'awaiting_consolidation', 'consolidated', 'ready_for_vip', 'ready_for_vip_dispatch', 'vip_dispatched', 'delivered',
    'cancelled'
  )
);
