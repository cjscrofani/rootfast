-- Rootfast schema migration 004 — composite index on plant_wetland_indicators.
--
-- The 003-era pushExists() filter generates:
--   EXISTS (SELECT 1 FROM plant_wetland_indicators
--            WHERE plant_id = p.id AND wetland_code IN (?))
-- SQLite's planner picks idx_pwi_code (wetland_code only) and then has to
-- check each candidate row's plant_id against the outer plants row — fine
-- in isolation but pathological combined with the outer
-- `ORDER BY p.scientific_name LIMIT N` on /v1/plants. The page-render path
-- was timing out at ~40 s.
--
-- A composite index on (wetland_code, plant_id) lets the planner reduce
-- the subquery to a tight index scan and reformulate as a semi-join.

CREATE INDEX IF NOT EXISTS idx_pwi_code_plant
  ON plant_wetland_indicators(wetland_code, plant_id);

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '004', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_004', 'wetland_index', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
