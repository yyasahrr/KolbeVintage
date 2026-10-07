-- 035 created this constraint from UNIQUE (product_id, user_id). 048 tried to
-- remove a differently named constraint, leaving one review per product forever.
ALTER TABLE customer_reviews
  DROP CONSTRAINT IF EXISTS customer_reviews_product_id_user_id_key;

-- The expression index from 048 is the purchase-scoped uniqueness guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS customer_reviews_product_user_idx
  ON customer_reviews(product_id, user_id,
    COALESCE(order_id, '00000000-0000-0000-0000-000000000000'::uuid));
