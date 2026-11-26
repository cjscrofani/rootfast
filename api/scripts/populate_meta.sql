-- Stamp dataset provenance + headline counts into schema_meta so /healthz can
-- report what is actually loaded instead of a hard-coded number. Idempotent
-- (upserts), cheap to re-run, and safe against D1 directly:
--
--     wrangler d1 execute rootfast --remote --file api/scripts/populate_meta.sql
--
-- (The `WHERE 1` clauses are required: SQLite can't tell `ON CONFLICT` from a
-- join's `ON` after a bare `INSERT ... SELECT ... FROM t`.)
--
-- `dataset_version` is NOT set here — build.py stamps it (from --tag or from
-- dataset_date). On D1 you can set it by hand:
--     INSERT INTO schema_meta (key, value, updated_at) VALUES ('dataset_version','2026.05',datetime('now'))
--       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'dataset_date', substr(MAX(fetched_at), 1, 10), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM plants WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'source_usda_plants_pulled', substr(MAX(fetched_at), 1, 10), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM plants WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('source_usda_hardiness_edition', '2023', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('source_census_zcta_vintage',    '2020', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- iNat photos are fetched in the same ETL pass as the plants; reuse that date.
INSERT INTO schema_meta (key, value, updated_at)
SELECT 'source_inaturalist_photos_pulled', substr(MAX(fetched_at), 1, 10), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM plants WHERE photo_url IS NOT NULL
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- Headline counts. "taxa" is accepted taxa only (matches the browsable list).
INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_taxa', COUNT(*), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM plants WHERE is_synonym = 0 AND is_excluded = 0
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_states', COUNT(DISTINCT c.state_code), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM plant_county_distribution pcd JOIN counties c ON c.county_fips = pcd.county_fips WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_counties', COUNT(*), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM counties WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_distribution', COUNT(*), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM plant_county_distribution WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_photos', COUNT(*), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM plants WHERE photo_url IS NOT NULL AND is_synonym = 0 AND is_excluded = 0
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_hardiness_zips', COUNT(*), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM hardiness_zones_by_zip WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_hardiness_counties', COUNT(*), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM hardiness_zones_by_county WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at)
SELECT 'count_zip_counties', COUNT(DISTINCT zip_code), strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM zip_counties WHERE 1
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
