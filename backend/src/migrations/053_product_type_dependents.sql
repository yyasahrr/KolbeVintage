-- Restore distinct size mappings captured ahead of 051. The surviving row's
-- mapping wins when both rows contained the same code.
INSERT INTO product_type_sizes(id, product_type_id, code, label, active, position)
SELECT gen_random_uuid(), r.keeper_id, r.code, r.label, r.active, r.position
FROM product_type_size_recovery r
ON CONFLICT (product_type_id, code) DO NOTHING;

-- Also materialize any JSON-only size definitions into the relational model.
INSERT INTO product_type_sizes(id, product_type_id, code, label, active, position)
SELECT gen_random_uuid(), t.id, item.elem->>'code',
       COALESCE(NULLIF(item.elem->>'label', ''), item.elem->>'code'),
       COALESCE((item.elem->>'active')::boolean, true),
       COALESCE((item.elem->>'position')::integer, item.ord::integer)
FROM product_types t
CROSS JOIN LATERAL jsonb_array_elements(t.sizes) WITH ORDINALITY AS item(elem, ord)
WHERE item.elem->>'code' IS NOT NULL
ON CONFLICT (product_type_id, code) DO NOTHING;

-- Keep both product-type representations aligned and repair references 051
-- repointed without updating the denormalized code.
UPDATE products p SET product_type_code = t.code
FROM product_types t
WHERE p.product_type_id = t.id AND p.product_type_code IS DISTINCT FROM t.code;

UPDATE products p SET product_type_id = m.keeper_id, product_type_code = m.keeper_code
FROM product_type_recovery_map m
WHERE p.product_type_id IS NULL AND p.product_type_code = m.losing_code;

UPDATE product_types t SET sizes = s.sizes
FROM (
  SELECT product_type_id, jsonb_agg(jsonb_build_object(
    'code', code, 'label', label, 'active', active, 'position', position)
    ORDER BY position, code) AS sizes
  FROM product_type_sizes GROUP BY product_type_id
) s
WHERE t.id = s.product_type_id AND t.sizes IS DISTINCT FROM s.sizes;

DROP TABLE product_type_size_recovery;
DROP TABLE product_type_recovery_map;
