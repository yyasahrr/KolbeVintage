-- 051: product_types name-level dedupe (integration fix).
--
-- Collision matrix row "product_types 016+035": migration 016 seeded code='pants' name='شلوار'
-- (id c3000000-0003-…) and migration 035 seeded code='trousers' name='شلوار' (id 8a880000-…0003).
-- The two seeds conflict on `code` (different codes) so both rows survive on every fresh database,
-- and every downstream consumer that keys or looks up product types by NAME (supplier product form
-- <Select>, admin product studio, profile/structure lists) sees a duplicate — React literally
-- reported "Encountered two children with the same key, شلوار" in the browser smoke.
--
-- Resolution follows the documented collision decision "016+035 -> 035": the 035 adaptive row
-- (rich sizes/spec_template/size guide) is canonical. This forward migration:
--   1. repoints product references from losing rows to the canonical row,
--   2. carries over spec_template_id when the canonical row has none,
--   3. merges empty jsonb sizes from the losing row,
--   4. deletes any other name-duplicated rows (keeping the richest/first by position),
--   5. enforces name uniqueness so the duplicate can never silently return.
-- product_type_sizes children of deleted rows cascade (FK ON DELETE CASCADE, 016).

DO $$
DECLARE
  dup record;
  keeper uuid;
  has_spec_template boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_types' AND column_name = 'spec_template_id'
  ) INTO has_spec_template;

  FOR dup IN SELECT name FROM product_types GROUP BY name HAVING count(*) > 1 LOOP
    -- Canonical row: prefer the adaptive (035) shape — non-empty spec template, then sizes,
    -- then lowest position, then lowest id for determinism.
    SELECT id INTO keeper
    FROM product_types
    WHERE name = dup.name
    ORDER BY (spec_template <> '[]'::jsonb) DESC,
             (sizes <> '[]'::jsonb) DESC,
             position ASC,
             id ASC
    LIMIT 1;

    -- 1. Repoint product references before the delete (products.product_type_id has no ON DELETE rule).
    UPDATE products SET product_type_id = keeper
    WHERE product_type_id IN (SELECT id FROM product_types WHERE name = dup.name AND id <> keeper);

    -- 2. Carry over the spec-template link when the canonical row does not have one yet.
    IF has_spec_template THEN
      EXECUTE '
        UPDATE product_types dst SET spec_template_id = src.spec_template_id
        FROM product_types src
        WHERE dst.id = $1
          AND src.name = $2 AND src.id <> $1
          AND dst.spec_template_id IS NULL AND src.spec_template_id IS NOT NULL'
        USING keeper, dup.name;
    END IF;

    -- 3. Merge jsonb sizes when the canonical row has none (deterministic pick: lowest id).
    UPDATE product_types dst SET sizes = (
      SELECT src.sizes FROM product_types src
      WHERE src.name = dup.name AND src.id <> dst.id AND src.sizes <> '[]'::jsonb
      ORDER BY src.id LIMIT 1
    )
    WHERE dst.id = keeper
      AND dst.sizes = '[]'::jsonb
      AND EXISTS (SELECT 1 FROM product_types src
                  WHERE src.name = dup.name AND src.id <> keeper AND src.sizes <> '[]'::jsonb);

    -- 4. Delete the losing duplicates (product_type_sizes children cascade).
    DELETE FROM product_types WHERE name = dup.name AND id <> keeper;
  END LOOP;
END $$;

-- 5. Product type name is the lookup key used by every select/list in the app — enforce it.
CREATE UNIQUE INDEX IF NOT EXISTS product_types_name_unique ON product_types(name);
