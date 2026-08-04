-- Refill the precomputed summary tables (schema/006_summaries.sql) from the
-- current base data. Idempotent: clears then repopulates, so it is safe to run
-- after every data load and to re-run against D1.
--
-- Used by:
--   * api/scripts/build.py — after merging source data, before dumping.
--   * a one-time backfill of production D1:
--       wrangler d1 execute rootfast --remote --file api/schema/006_summaries.sql
--       wrangler d1 execute rootfast --remote --file api/scripts/populate_summaries.sql

DELETE FROM plant_endemic_state;
INSERT INTO plant_endemic_state (plant_id, state_code)
SELECT p.id, MIN(c.state_code)
  FROM plants p
  JOIN plant_county_distribution pcd ON pcd.plant_id  = p.id
  JOIN counties                  c   ON c.county_fips = pcd.county_fips
 WHERE p.is_synonym = 0 AND p.is_excluded = 0
 GROUP BY p.id
HAVING COUNT(DISTINCT c.state_code) = 1;

DELETE FROM county_taxa_summary;
INSERT INTO county_taxa_summary (county_fips, taxa_count, photo_count)
SELECT c.county_fips,
       COUNT(DISTINCT pcd.plant_id),
       COUNT(DISTINCT CASE WHEN p.photo_url IS NOT NULL THEN p.id END)
  FROM counties c
  LEFT JOIN plant_county_distribution pcd ON pcd.county_fips = c.county_fips
  LEFT JOIN plants                    p   ON p.id            = pcd.plant_id
 GROUP BY c.county_fips;
