-- Rootfast migration 007 — ZIP → county crosswalk.
--
-- Lets a 5-digit ZIP resolve to the county (or counties) it sits in, which is
-- what turns "what grows near ZIP 59715?" into a plant_county_distribution
-- query. Source: the US Census Bureau's 2020 ZCTA-to-county relationship
-- file (public domain). ZCTAs are the Census generalisation of USPS ZIP
-- delivery areas, so a handful of PO-box-only and single-building ZIPs have
-- no row here; the API falls back to a 404 for those.
--
-- One row per (ZIP, county) pair. Most ZIPs map to exactly one county;
-- ~10% straddle two or more. land_share is the fraction of the ZCTA's land
-- area that falls inside that county, so callers can pick the primary county
-- (highest share) or union across all of them.
CREATE TABLE zip_counties (
  zip_code    TEXT NOT NULL,
  county_fips TEXT NOT NULL REFERENCES counties(county_fips),
  land_share  REAL NOT NULL CHECK (land_share >= 0 AND land_share <= 1),
  PRIMARY KEY (zip_code, county_fips)
);
CREATE INDEX idx_zip_counties_county ON zip_counties(county_fips);

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '007', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_007', 'zip_counties', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
