-- Rootfast schema migration 002 — add iNaturalist photo columns to plants.
--
-- Each USDA taxon may carry a single primary photo, hot-linked from iNat's
-- public S3 bucket. We don't rehost: hot-linking is allowed under iNat's
-- terms and avoids inheriting copyright liability.
--
-- Coverage: ~100% of MT plants tested. Licenses skew CC-BY-NC (~80%),
-- with some CC-BY-NC-ND, CC-BY, and CC0. The photo_license column is the
-- source of truth — downstream consumers filter by it if needed.

ALTER TABLE plants ADD COLUMN photo_source       TEXT;     -- 'inaturalist'
ALTER TABLE plants ADD COLUMN photo_source_id    INTEGER;  -- iNat photo id
ALTER TABLE plants ADD COLUMN photo_taxon_id     INTEGER;  -- iNat taxon id
ALTER TABLE plants ADD COLUMN photo_url          TEXT;     -- medium (~500px)
ALTER TABLE plants ADD COLUMN photo_thumb_url    TEXT;     -- square (~75px)
ALTER TABLE plants ADD COLUMN photo_license      TEXT;     -- 'cc-by-nc' etc.
ALTER TABLE plants ADD COLUMN photo_attribution  TEXT;     -- '(c) photographer …'

CREATE INDEX IF NOT EXISTS idx_plants_has_photo
  ON plants(photo_url) WHERE photo_url IS NOT NULL;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '002', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_002', 'photos', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
