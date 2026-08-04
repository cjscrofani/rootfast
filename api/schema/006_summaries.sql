-- Rootfast migration 006 — precomputed summary tables.
--
-- These denormalize two expensive aggregations off the ~2.5M-row
-- plant_county_distribution table so the endpoints serving them don't scan it
-- on every request. They are DATA, derived from the base tables, and are
-- refilled by api/scripts/populate_summaries.sql (run by build.py after the
-- data load, and once against D1 to backfill existing data).

-- Endemic taxa — accepted plants whose entire distribution lives in one state.
-- One row per endemic plant → its sole state. Restricted to accepted taxa
-- (is_synonym = 0, is_excluded = 0) so the per-state count matches the
-- browsable taxa list; the previous count query included synonyms/excluded and
-- overstated the total relative to the list users could actually page through.
CREATE TABLE plant_endemic_state (
  plant_id   INTEGER PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
  state_code TEXT NOT NULL REFERENCES states(state_code)
);
CREATE INDEX idx_endemic_state ON plant_endemic_state(state_code);

-- Per-county taxa + photo counts for the biodiversity / photo-coverage maps.
-- taxa_count  = distinct plant_ids recorded in the county (matches the prior
--               endpoints' semantics — all distribution rows, not accepted-only).
-- photo_count = of those, how many have an iNaturalist photo.
-- Every county gets a row (0 when it has no distribution records).
CREATE TABLE county_taxa_summary (
  county_fips TEXT PRIMARY KEY REFERENCES counties(county_fips) ON DELETE CASCADE,
  taxa_count  INTEGER NOT NULL DEFAULT 0,
  photo_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '006', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_006', 'summaries', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
