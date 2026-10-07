-- Immutable publication metadata and optimistic draft revisions. Existing history is retained.
ALTER TABLE cms_pages ADD COLUMN draft_revision integer NOT NULL DEFAULT 1;
ALTER TABLE cms_pages ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE cms_page_versions
  ADD COLUMN path text,
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN starts_at timestamptz,
  ADD COLUMN ends_at timestamptz,
  ADD COLUMN draft_revision integer;
UPDATE cms_page_versions v SET path=p.path, description=p.description, active=p.active,
  starts_at=p.scheduled_start_at, ends_at=p.scheduled_end_at
FROM cms_pages p WHERE p.id=v.page_id;
-- Freeze legacy live content once; public reads must never fall back to mutable sections.
INSERT INTO cms_page_versions(id,page_id,version,title,status,sections_snapshot,seo_snapshot,path,description,active,starts_at,ends_at,draft_revision,change_summary)
SELECT gen_random_uuid(),p.id,p.version,p.title,p.status,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'payload',s.payload,'visible',s.visible,'position',s.position,
    'component_code',c.code,'component_type',c.component_type,'variant',s.variant,'preset',s.preset,'section_theme',s.section_theme,
    'data_binding',s.data_binding,'style_overrides',s.style_overrides,'responsive_config',s.responsive_config,'composition',c.composition) ORDER BY s.position,s.created_at)
    FROM cms_sections s JOIN cms_components c ON c.id=s.component_id WHERE s.page_id=p.id),'[]'::jsonb),
  p.seo,p.path,p.description,p.active,p.scheduled_start_at,p.scheduled_end_at,p.draft_revision,'ثبت نسخه زنده پیش از جداسازی پیش‌نویس'
FROM cms_pages p WHERE p.status IN ('published','scheduled') AND NOT EXISTS(SELECT 1 FROM cms_page_versions v WHERE v.page_id=p.id);

CREATE FUNCTION cms_touch_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cms_pages SET draft_revision=draft_revision+1, updated_at=clock_timestamp() WHERE id=COALESCE(NEW.page_id,OLD.page_id);
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER cms_sections_touch_draft AFTER INSERT OR UPDATE OR DELETE ON cms_sections FOR EACH ROW EXECUTE FUNCTION cms_touch_draft();
CREATE FUNCTION cms_page_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.title,NEW.path,NEW.description,NEW.active) IS DISTINCT FROM (OLD.title,OLD.path,OLD.description,OLD.active) THEN
    NEW.draft_revision=OLD.draft_revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cms_pages_touch_draft BEFORE UPDATE ON cms_pages FOR EACH ROW EXECUTE FUNCTION cms_page_draft_revision();

ALTER TABLE editorial_posts ADD COLUMN published_snapshot jsonb, ADD COLUMN publication_enabled boolean NOT NULL DEFAULT false;
UPDATE editorial_posts SET publication_enabled=true,published_snapshot=to_jsonb(editorial_posts)-'published_snapshot' WHERE status='published';
CREATE FUNCTION editorial_publication_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='published' THEN
    PERFORM pg_advisory_xact_lock(hashtext('editorial-publication-slugs'));
    IF EXISTS (SELECT 1 FROM editorial_posts p WHERE p.id<>NEW.id AND p.publication_enabled
      AND p.published_snapshot->>'slug'=NEW.slug) THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='نشانی مطلب با نسخه منتشرشده دیگری تداخل دارد';
    END IF;
    NEW.publication_enabled=true;
    NEW.published_snapshot=to_jsonb(NEW)-'published_snapshot';
  ELSIF NEW.status='archived' THEN NEW.publication_enabled=false;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_freeze_publication BEFORE INSERT OR UPDATE ON editorial_posts FOR EACH ROW EXECUTE FUNCTION editorial_publication_snapshot();
CREATE VIEW editorial_live AS
SELECT live.* FROM editorial_posts draft
CROSS JOIN LATERAL jsonb_populate_record(NULL::editorial_posts,draft.published_snapshot) live
WHERE draft.publication_enabled AND draft.status<>'archived' AND draft.published_snapshot IS NOT NULL;
