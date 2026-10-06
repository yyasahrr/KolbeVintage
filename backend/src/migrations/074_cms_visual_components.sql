-- Visual options are registered by the application release, not authored in the admin UI.
UPDATE cms_components
SET field_schema = jsonb_set(
  jsonb_set(field_schema, '{props}', COALESCE(field_schema->'props', '[]'::jsonb) || '["fontFamily"]'::jsonb),
  '{fields}', COALESCE(field_schema->'fields', '[]'::jsonb) || '[{"key":"fontFamily","type":"select","label":"فونت شمارشگر","group":"style","options":["site","display","mono"],"default":"site"}]'::jsonb
), updated_at = now()
WHERE code = 'countdown' AND NOT (field_schema->'props' ? 'fontFamily');

UPDATE cms_components
SET variants = CASE WHEN variants ? 'circle' THEN variants ELSE variants || '["circle"]'::jsonb END,
    field_schema = jsonb_set(field_schema, '{fields}',
      (SELECT jsonb_agg(CASE WHEN f->>'key' = 'template' THEN jsonb_set(f, '{options}', (f->'options') || '["circle"]'::jsonb) ELSE f END)
       FROM jsonb_array_elements(field_schema->'fields') AS f)),
    updated_at = now()
WHERE code IN ('category_card', 'category_section')
  AND NOT (field_schema->'fields' @> '[{"key":"template","options":["circle"]}]'::jsonb);
