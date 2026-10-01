-- 061: Festival XOR standalone discount (section A5/A6).
-- When a product enters an active festival, its standalone promotion rules are
-- SUSPENDED (not deleted) by stamping the suspending festival promotion id.
-- The suspension is only effective while that festival promotion is active and in
-- its time window, so leaving/ending the festival automatically restores rules that
-- are still valid by their own starts_at/ends_at.

ALTER TABLE promotion_rules
  ADD COLUMN IF NOT EXISTS suspended_by_promotion_id uuid REFERENCES promotions(id);

CREATE INDEX IF NOT EXISTS promotion_rules_suspended_idx
  ON promotion_rules(suspended_by_promotion_id)
  WHERE suspended_by_promotion_id IS NOT NULL;
