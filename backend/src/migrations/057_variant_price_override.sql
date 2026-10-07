-- 056: variant-level retail price override (Req 25, user-approved).
-- NULL = the variant follows the product base retail price; a value replaces
-- the cash price for that single variant (integer RIAL, like every money column).
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS price_override_rial BIGINT NULL
  CHECK (price_override_rial IS NULL OR price_override_rial >= 0);
