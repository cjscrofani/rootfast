-- Rootfast schema migration 005 — USDA-NRCS SSURGO soil summary per county.
--
-- One row per US county with the representative surface soil profile sampled
-- at the county's centroid. Component-percentage-weighted means of horizons
-- starting within the top 25 cm.
--
-- Source: USDA-NRCS Soil Data Access (SDA) REST endpoint, public domain.
--
-- Per-address soil lookup (lat/lng → mukey → component) is deferred to a
-- future runtime endpoint that would proxy SDA directly; the county summary
-- here is the cached, edge-served baseline.

CREATE TABLE soil_by_county (
  county_fips        TEXT PRIMARY KEY REFERENCES counties(county_fips),
  mukey              INTEGER,                -- USDA map-unit key sampled at the centroid
  muname             TEXT,                   -- "Straw loam, 0 to 4 percent slopes"
  dominant_comp      TEXT,                   -- highest-percent component name (e.g. "Straw")
  drainage_class     TEXT,                   -- USDA drainage class label
  slope_pct          REAL,                   -- representative slope %
  surface_ph         REAL,                   -- weighted-mean pH (1:1 H2O), surface 0-25cm
  surface_om_pct     REAL,                   -- weighted-mean organic matter %
  surface_sand_pct   REAL,                   -- weighted-mean sand %
  surface_silt_pct   REAL,                   -- weighted-mean silt %
  surface_clay_pct   REAL,                   -- weighted-mean clay %
  texture_class      TEXT,                   -- derived USDA texture (Sand/Loamy sand/.../Clay)
  awc_in_top_25cm    REAL                    -- weighted-mean available water capacity (in/in)
);

CREATE INDEX idx_soil_drainage ON soil_by_county(drainage_class);
CREATE INDEX idx_soil_texture  ON soil_by_county(texture_class);
CREATE INDEX idx_soil_ph       ON soil_by_county(surface_ph);

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '005', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_005', 'soil', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
