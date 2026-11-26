-- Rootfast migration 008 — read-cost summaries + daily usage ledger.
--
-- D1 bills (and, on the Workers Free plan, caps) by ROWS READ, not rows
-- returned. Before this migration the busiest endpoints re-aggregated the
-- ~2.5M-row plant_county_distribution table on every request:
--
--   /v1/states/{code}/counties   ~69,000 rows read per call
--   /v1/states/{code}/plants     ~150,000 rows read per call (x2 with the count)
--   /v1/counties/{fips}/plants   ~5,000 rows read per call
--   /v1/plants?max_counties=N    ~2,500,000 rows read per call
--
-- The tables below hold those answers precomputed so a request reads tens or
-- hundreds of rows instead. Like migration 006 they are DATA derived from the
-- base tables and are refilled by api/scripts/populate_summaries.sql (run by
-- build.py after the data load, and against D1 after applying this file).

-- Per-county counts of ACCEPTED taxa (is_synonym = 0, is_excluded = 0), in
-- total and by USDA's per-county nativity flag. These are the `total` the
-- county plant listing reports, with and without a single-value nativity
-- filter, so the listing no longer counts the county's rows on every call.
ALTER TABLE county_taxa_summary ADD COLUMN accepted_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE county_taxa_summary ADD COLUMN native_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE county_taxa_summary ADD COLUMN introduced_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE county_taxa_summary ADD COLUMN both_count       INTEGER NOT NULL DEFAULT 0;

-- Alphabetical position of every accepted taxon (by scientific_name, then id).
-- Lets the per-county listing below be stored — and read — in name order.
CREATE TABLE plant_name_rank (
  plant_id  INTEGER PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
  name_rank INTEGER NOT NULL UNIQUE
);

-- Accepted taxa per county, clustered in scientific-name order. The default
-- county listing (`ORDER BY scientific_name LIMIT 50`) walks this primary key
-- and stops after one page instead of reading and sorting the whole county.
CREATE TABLE county_plants (
  county_fips TEXT    NOT NULL REFERENCES counties(county_fips),
  name_rank   INTEGER NOT NULL,
  plant_id    INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  nativity    TEXT    NOT NULL CHECK (nativity IN ('Native','Introduced','Both')),
  PRIMARY KEY (county_fips, name_rank)
) WITHOUT ROWID;

-- Accepted taxa per state with their county rollup, clustered in
-- scientific-name order. Replaces the plants x distribution x counties
-- GROUP BY behind /v1/states/{code}/plants.
--   county_count        = counties of the state the taxon is recorded in
--   native_counties     = of those, counties flagged Native
--   introduced_counties = ... flagged Introduced
--   both_counties       = ... flagged Both
CREATE TABLE state_plants (
  state_code          TEXT    NOT NULL REFERENCES states(state_code),
  scientific_name     TEXT    NOT NULL,
  plant_id            INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  county_count        INTEGER NOT NULL,
  native_counties     INTEGER NOT NULL,
  introduced_counties INTEGER NOT NULL,
  both_counties       INTEGER NOT NULL,
  PRIMARY KEY (state_code, scientific_name, plant_id)
) WITHOUT ROWID;

-- One row per state that has distribution data.
--   county_count     = counties in the state
--   taxa_count       = distinct plant_ids recorded anywhere in the state (all
--                      distribution rows — the figure /v1/states has always shown)
--   accepted_count   = accepted taxa recorded in the state
--   native_count     = accepted taxa with at least one Native county
--   introduced_count = ... at least one Introduced county
--   both_count       = ... at least one Both county
CREATE TABLE state_taxa_summary (
  state_code       TEXT PRIMARY KEY REFERENCES states(state_code),
  county_count     INTEGER NOT NULL DEFAULT 0,
  taxa_count       INTEGER NOT NULL DEFAULT 0,
  accepted_count   INTEGER NOT NULL DEFAULT 0,
  native_count     INTEGER NOT NULL DEFAULT 0,
  introduced_count INTEGER NOT NULL DEFAULT 0,
  both_count       INTEGER NOT NULL DEFAULT 0
);

-- How many counties each plant is recorded in, nationally. Backs the
-- min_counties / max_counties filters (plants with no distribution rows have
-- no row here, matching the previous GROUP BY ... HAVING behaviour).
CREATE TABLE plant_range_summary (
  plant_id     INTEGER PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
  county_count INTEGER NOT NULL
);
CREATE INDEX idx_plant_range_count ON plant_range_summary(county_count);

-- Operational, not dataset: one row per UTC day with the rows the API has
-- read from D1 and the requests it has served. The Worker adds to it in
-- batches and stops running dataset queries once the day's row budget is
-- spent (see DAILY_ROWS_BUDGET in api/wrangler.toml). It only sees the
-- Worker's own queries — wrangler, the dashboard and release exports are not
-- counted — which is why the budget sits below the plan limit. Excluded from
-- dataset releases.
CREATE TABLE usage_daily (
  day        TEXT PRIMARY KEY,                    -- 'YYYY-MM-DD' (UTC)
  rows_read  INTEGER NOT NULL DEFAULT 0,
  requests   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Operational, not dataset: finished responses that were expensive to
-- compute (thousands of rows read), keyed by canonical request URL plus the
-- dataset version. Cloudflare's edge cache is per location, so a crawler
-- arriving through fifty locations costs fifty recomputations; this table is
-- global and answers for one row read. The Worker trims it to a fixed number
-- of entries, oldest first. Excluded from dataset releases.
CREATE TABLE response_cache (
  key                 TEXT PRIMARY KEY,
  content_type        TEXT NOT NULL,
  cache_control       TEXT NOT NULL,
  etag                TEXT,
  content_disposition TEXT,
  body                TEXT NOT NULL,
  rows_cost           INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_response_cache_created ON response_cache(created_at);

-- Two original indexes on plant_county_distribution are exact prefixes of
-- other indexes, so they only cost space (about 60 MB together):
--   idx_pcd_plant  (plant_id)     is covered by the PRIMARY KEY (plant_id, county_fips)
--   idx_pcd_county (county_fips)  is covered by idx_pcd_county_nativity (county_fips, nativity)
-- Dropping them pays for the summary tables above and keeps the database
-- under the Workers Free plan's 500 MB per-database limit.
DROP INDEX IF EXISTS idx_pcd_plant;
DROP INDEX IF EXISTS idx_pcd_county;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '008', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('migration_008', 'read_cost', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(key) DO NOTHING;
