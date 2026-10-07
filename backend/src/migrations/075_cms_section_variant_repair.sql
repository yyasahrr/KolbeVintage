-- Some starter sections predate component variants and still carry the old
-- database default. Bring only invalid values in line with the canonical
-- component registry, preserving an explicitly configured template when valid.
UPDATE cms_sections AS section
SET variant = CASE
  WHEN component.variants ? (section.payload ->> 'template') THEN section.payload ->> 'template'
  ELSE COALESCE(component.variants ->> 0, 'default')
END
FROM cms_components AS component
WHERE section.component_id = component.id
  AND jsonb_typeof(component.variants) = 'array'
  AND jsonb_array_length(component.variants) > 0
  AND NOT (component.variants ? section.variant);
