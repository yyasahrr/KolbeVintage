-- Explicit commercial series pricing; existing templates retain legacy terms.
ALTER TABLE series_templates ADD COLUMN pricing_mode text NOT NULL DEFAULT 'legacy_product'
  CHECK (pricing_mode IN ('legacy_product', 'series_total', 'component_sum'));
ALTER TABLE series_templates ADD COLUMN total_price_rial bigint CHECK (total_price_rial IS NULL OR total_price_rial > 0);
ALTER TABLE series_templates ADD COLUMN min_order_series integer NOT NULL DEFAULT 1 CHECK (min_order_series > 0);
ALTER TABLE series_template_items ADD COLUMN unit_price_rial bigint CHECK (unit_price_rial IS NULL OR unit_price_rial >= 0);
ALTER TABLE series_templates ADD CONSTRAINT series_total_price_required
  CHECK (pricing_mode <> 'series_total' OR total_price_rial IS NOT NULL);
