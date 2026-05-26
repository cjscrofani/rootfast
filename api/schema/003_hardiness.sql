-- Rootfast schema migration 003 — USDA Plant Hardiness Zones (2023).
--
-- Two USDA-ARS data products joined together here:
--
--   1. PHZM_2023_Zip_Code_Table  — 40,502 ZIPs → zone class
--   2. PHZM_Links_with_zones L6  — state × zone polygons (371 features)
--      The polygons themselves stay in raw GeoJSON files (too heavy for
--      D1); we only persist the *derived* county-centroid → zone here.
--
-- The join key against the existing schema is the location, not the
-- plant. Plant-side cold tolerance lives in plant_characteristics.
-- temperature_min_f; a typical query is:
--
--     SELECT p.scientific_name
--       FROM plants p
--       JOIN plant_characteristics pc ON pc.plant_id = p.id
--       JOIN hardiness_zones hz       ON hz.zone_code = '5a'
--      WHERE pc.temperature_min_f <= hz.temp_min_f;

-- Canonical 1a–13b half-zone reference. 26 rows total.
-- Source: USDA-ARS PHZM 2023 Class definitions.
CREATE TABLE hardiness_zones (
  zone_code        TEXT PRIMARY KEY,           -- '5a','5b','13b'
  zone_class_code  INTEGER NOT NULL UNIQUE,    -- 1=1a, 2=1b, …, 9=5a, 10=5b, …, 26=13b
  temp_min_f       REAL NOT NULL,              -- lower bound, e.g. -20 for 5a
  temp_max_f       REAL NOT NULL,              -- upper bound, e.g. -15 for 5a
  description      TEXT NOT NULL               -- '5a (-20 to -15 °F)'
);

-- ZIP → zone. ~40,502 rows. Authoritative USDA lookup table.
-- Note: ZIPs cross state lines and change over time; this is the 2023 snapshot.
CREATE TABLE hardiness_zones_by_zip (
  zip_code   TEXT PRIMARY KEY,
  zone_code  TEXT NOT NULL REFERENCES hardiness_zones(zone_code)
);
CREATE INDEX idx_hzbz_zone ON hardiness_zones_by_zip(zone_code);

-- Predominant zone per county, derived by sampling each county's centroid
-- against the PHZM polygon layer at ETL time. One zone per county loses
-- sub-county variation — for accurate per-address lookup, use the ZIP table.
CREATE TABLE hardiness_zones_by_county (
  county_fips  TEXT PRIMARY KEY REFERENCES counties(county_fips),
  zone_code    TEXT NOT NULL REFERENCES hardiness_zones(zone_code)
);
CREATE INDEX idx_hzbc_zone ON hardiness_zones_by_county(zone_code);

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '003', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_003', 'hardiness', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
