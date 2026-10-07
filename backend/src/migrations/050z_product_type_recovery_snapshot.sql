-- Capture dependent data before the already-published 051 dedupe runs on a
-- fresh or pre-051 database. The migration runner orders pending files by name.
-- On databases where 051 already ran, these tables remain empty; data that 051
-- cascaded away can only be restored from an external backup.
CREATE TABLE IF NOT EXISTS product_type_recovery_map (
  losing_id uuid PRIMARY KEY,
  losing_code text NOT NULL,
  keeper_id uuid NOT NULL,
  keeper_code text NOT NULL
);

INSERT INTO product_type_recovery_map(losing_id, losing_code, keeper_id, keeper_code)
SELECT losing.id, losing.code, keeper.id, keeper.code
FROM product_types losing
JOIN LATERAL (
  SELECT id, code FROM product_types candidate WHERE candidate.name = losing.name
  ORDER BY (candidate.spec_template <> '[]'::jsonb) DESC,
           (candidate.sizes <> '[]'::jsonb) DESC, candidate.position, candidate.id
  LIMIT 1
) keeper ON keeper.id <> losing.id
ON CONFLICT (losing_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS product_type_size_recovery (
  original_type_id uuid NOT NULL,
  keeper_id uuid NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  active boolean NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (original_type_id, code)
);

INSERT INTO product_type_size_recovery(original_type_id, keeper_id, code, label, active, position)
SELECT s.product_type_id, m.keeper_id, s.code, s.label, s.active, s.position
FROM product_type_sizes s JOIN product_type_recovery_map m ON m.losing_id = s.product_type_id
ON CONFLICT (original_type_id, code) DO NOTHING;
