-- One category identity: CMS taxonomy supplies hierarchy/presentation;
-- category_profiles extends that same identity with catalog defaults.
-- Text labels remain compatibility projections. No historical rows are deleted.
DO $$ BEGIN
  IF EXISTS (SELECT name FROM cms_categories GROUP BY name HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate category names require reconciliation before canonical category migration';
  END IF;
END $$;
CREATE UNIQUE INDEX cms_categories_name_unique ON cms_categories(name);

INSERT INTO cms_categories(id, name, slug)
SELECT gen_random_uuid(), names.category, 'catalog-' || gen_random_uuid()::text
FROM (SELECT category FROM products UNION SELECT category FROM category_profiles) names
WHERE NOT EXISTS (SELECT 1 FROM cms_categories c WHERE c.name = names.category);

ALTER TABLE products ADD COLUMN category_id uuid REFERENCES cms_categories(id) ON DELETE RESTRICT;
ALTER TABLE category_profiles ADD COLUMN category_id uuid REFERENCES cms_categories(id) ON DELETE RESTRICT;
UPDATE products p SET category_id = c.id FROM cms_categories c WHERE p.category = c.name;
UPDATE category_profiles p SET category_id = c.id FROM cms_categories c WHERE p.category = c.name;
ALTER TABLE products ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE category_profiles ALTER COLUMN category_id SET NOT NULL;
CREATE UNIQUE INDEX category_profiles_category_id_unique ON category_profiles(category_id);
CREATE INDEX products_category_id_idx ON products(category_id);

-- Legacy clients provide names; resolve them once to canonical IDs. A new label
-- creates an actual taxonomy record, not an independently editable text category.
CREATE FUNCTION resolve_catalog_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolved_id uuid; resolved_name text;
BEGIN
  IF NEW.category_id IS NOT NULL AND
     (TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id) THEN
    SELECT name INTO STRICT resolved_name FROM cms_categories WHERE id = NEW.category_id;
    NEW.category := resolved_name;
  ELSE
    INSERT INTO cms_categories(id, name, slug)
    VALUES (gen_random_uuid(), NEW.category, 'catalog-' || gen_random_uuid()::text)
    ON CONFLICT (name) DO NOTHING;
    SELECT id INTO STRICT resolved_id FROM cms_categories WHERE name = NEW.category;
    NEW.category_id := resolved_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_category_identity BEFORE INSERT OR UPDATE OF category, category_id ON products
FOR EACH ROW EXECUTE FUNCTION resolve_catalog_category();
CREATE TRIGGER profiles_category_identity BEFORE INSERT OR UPDATE OF category, category_id ON category_profiles
FOR EACH ROW EXECUTE FUNCTION resolve_catalog_category();

-- Rename is a taxonomy operation. Dependent labels update atomically while IDs,
-- orders, inventories, prices and historic snapshots retain their identities.
CREATE FUNCTION project_catalog_category_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE products SET category = NEW.name WHERE category_id = NEW.id;
    UPDATE category_profiles SET category = NEW.name WHERE category_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER category_name_projection AFTER UPDATE OF name ON cms_categories
FOR EACH ROW EXECUTE FUNCTION project_catalog_category_name();
