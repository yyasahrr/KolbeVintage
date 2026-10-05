-- 061: Festival XOR standalone discount (section A5/A6).
-- When a product enters a Festival, its standalone promotion rules are SUSPENDED
-- (not deleted) by stamping the canonical Festival promotion id. DEC-PRICING-001
-- (Product Owner decision, 2026-10-04 / Option A): this marker persists after
-- Festival deactivation or expiry. Only an explicit Admin reactivation clears it.
-- The resolver additionally treats every Festival as exclusive from standalone rules.

ALTER TABLE promotion_rules
  ADD COLUMN IF NOT EXISTS suspended_by_promotion_id uuid REFERENCES promotions(id);

CREATE INDEX IF NOT EXISTS promotion_rules_suspended_idx
  ON promotion_rules(suspended_by_promotion_id)
  WHERE suspended_by_promotion_id IS NOT NULL;
