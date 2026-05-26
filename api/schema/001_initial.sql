-- Rootfast API — initial D1 schema.
--
-- Tables are organized into five sections:
--   1. Core identity      — plants, multi-valued attributes
--   2. Geography          — states, counties, regions, distribution
--   3. Characteristics    — USDA's per-plant attribute table (wide)
--   4. Enrichments        — wildlife, wetland, synonyms, status, refs (long)
--   5. Full-text search   — FTS5 mirror of plants for name search
--
-- DESIGN NOTES
--
-- * Surrogate INTEGER PRIMARY KEYs on plants/counties/states; natural
--   keys (usda_symbol, county_fips, etc.) are UNIQUE. Faster joins, plays
--   well with future sources whose native IDs aren't strings.
--
-- * `plants.gbif_taxon_key` is the JOIN KEY across all current and future
--   data sources. Filled by a one-time `/species/match` GBIF API call per
--   plant during ingest. May be NULL for taxa GBIF doesn't recognize.
--
-- * Provenance is documented PER TABLE (in the comment block above each
--   CREATE TABLE), not per cell. The API surfaces source attribution at
--   the response-object level. If a future source contradicts USDA on a
--   field, we'll add a per-field provenance table at that time.
--
-- * Wide vs long format for characteristics: wide. The USDA characteristic
--   set is stable (83 named attributes for ~25 years), filter queries are
--   common ("drought=High AND shade=High"), and most plants either have
--   the full set or none of it. NULLs are cheap in SQLite.
--
-- * Synonyms and excluded/deprecated taxa are kept as separate rows in
--   `plants` with `is_synonym=1` and `accepted_plant_id` pointing at the
--   canonical row. API lookups transparently redirect.

-- =====================================================================
-- SECTION 1 — CORE IDENTITY
-- =====================================================================

-- Top-level plant taxa. One row per USDA PLANTS record (species,
-- subspecies, variety, or form). Includes accepted, synonym, and excluded
-- entries — disambiguated by is_synonym/is_excluded flags.
--
-- Source: USDA PlantsService API (PlantProfile endpoint) +
--         GBIF Backbone (/species/match endpoint).
CREATE TABLE plants (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- USDA identifiers
  usda_symbol                 TEXT    NOT NULL UNIQUE,        -- e.g. 'PIPO'
  usda_plant_id               INTEGER UNIQUE,                  -- USDA internal id

  -- GBIF backbone (the join key across all sources)
  gbif_taxon_key              INTEGER,                         -- e.g. 5285750
  gbif_canonical_name         TEXT,                            -- e.g. 'Pinus ponderosa'
  gbif_match_type             TEXT
    CHECK (gbif_match_type IN ('EXACT','FUZZY','HIGHERRANK','NONE')),
  gbif_match_status           TEXT
    CHECK (gbif_match_status IN ('ACCEPTED','SYNONYM','DOUBTFUL')),
  gbif_match_confidence       INTEGER CHECK (gbif_match_confidence BETWEEN 0 AND 100),

  -- Cross-references GBIF often returns alongside the match
  itis_tsn                    INTEGER,
  wikidata_qid                TEXT,
  inaturalist_taxon_id        INTEGER,

  -- Names
  scientific_name             TEXT NOT NULL,                   -- 'Pinus ponderosa Lawson & C. Lawson'
  scientific_name_canonical   TEXT NOT NULL,                   -- 'Pinus ponderosa' (no authority)
  common_name                 TEXT,                            -- USDA's primary common name
  family                      TEXT,                            -- 'Pinaceae'
  genus                       TEXT,                            -- 'Pinus'

  -- Taxonomy
  taxonomic_group             TEXT,                            -- 'Dicot','Monocot','Gymnosperm','Pteridophyte','Bryophyte','Algae'
  rank                        TEXT NOT NULL
    CHECK (rank IN ('Species','Subspecies','Variety','Form')),

  -- USDA accepted/synonym/excluded handling
  is_synonym                  INTEGER NOT NULL DEFAULT 0 CHECK (is_synonym IN (0,1)),
  is_excluded                 INTEGER NOT NULL DEFAULT 0 CHECK (is_excluded IN (0,1)),
  accepted_plant_id           INTEGER REFERENCES plants(id),   -- if synonym/excluded → canonical
  parent_plant_id             INTEGER REFERENCES plants(id),   -- if subspecies/variety → species

  -- Ingest provenance
  source_version              TEXT NOT NULL,                   -- e.g. 'usda-plants-2026-Q2'
  fetched_at                  TEXT NOT NULL                    -- ISO 8601
);

CREATE INDEX idx_plants_gbif_key            ON plants(gbif_taxon_key);
CREATE INDEX idx_plants_family              ON plants(family);
CREATE INDEX idx_plants_genus               ON plants(genus);
CREATE INDEX idx_plants_canonical           ON plants(scientific_name_canonical);
CREATE INDEX idx_plants_accepted            ON plants(accepted_plant_id);
CREATE INDEX idx_plants_parent              ON plants(parent_plant_id);
CREATE INDEX idx_plants_rank_synonym        ON plants(rank, is_synonym) WHERE is_synonym = 0;


-- Many-to-many: a plant may have multiple growth habits ('Tree' + 'Shrub')
-- or durations ('Perennial' + 'Biennial').
CREATE TABLE plant_growth_habits (
  plant_id     INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  growth_habit TEXT    NOT NULL,                              -- 'Tree','Shrub','Forb/herb','Graminoid','Vine','Subshrub','Lichenous','Nonvascular'
  PRIMARY KEY (plant_id, growth_habit)
);
CREATE INDEX idx_pgh_habit ON plant_growth_habits(growth_habit);

CREATE TABLE plant_durations (
  plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  duration TEXT    NOT NULL CHECK (duration IN ('Perennial','Annual','Biennial')),
  PRIMARY KEY (plant_id, duration)
);
CREATE INDEX idx_pd_duration ON plant_durations(duration);


-- All known common names per plant. The "primary" one duplicates
-- plants.common_name; "other" names come from USDA's OtherCommonNames.
CREATE TABLE plant_common_names (
  plant_id     INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  common_name  TEXT    NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  PRIMARY KEY (plant_id, common_name)
);
CREATE INDEX idx_pcn_name ON plant_common_names(common_name);


-- =====================================================================
-- SECTION 2 — GEOGRAPHY
-- =====================================================================

-- USDA's coarse region taxonomy used in NativeStatuses (AK, CAN, L48, etc.).
CREATE TABLE regions (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  parent_code    TEXT REFERENCES regions(code)
);


-- Per-region native/introduced status for a plant.
-- Source: USDA PlantProfile.NativeStatuses
CREATE TABLE plant_native_status (
  plant_id     INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  region_code  TEXT    NOT NULL REFERENCES regions(code),
  status       TEXT    NOT NULL CHECK (status IN ('Native','Introduced','Both','Waif','Unknown')),
  PRIMARY KEY (plant_id, region_code)
);
CREATE INDEX idx_pns_region_status ON plant_native_status(region_code, status);


-- US states + territories + Canadian provinces (USDA's set).
CREATE TABLE states (
  state_code               TEXT PRIMARY KEY,                  -- 'MT', 'NY', 'PR'
  state_name               TEXT NOT NULL,
  state_fips               TEXT UNIQUE,                       -- '30' for MT (Canadian provinces NULL)
  country                  TEXT NOT NULL DEFAULT 'US',
  usda_plant_location_id   INTEGER UNIQUE                     -- USDA internal id (e.g. 3318 for MT)
);


-- Full US county set (when nationwide). Also captures Canadian provinces
-- as zero-county "state-equivalents" by convention if needed later.
-- Source: USDA boundaries MapServer + Census FIPS.
CREATE TABLE counties (
  county_fips              TEXT PRIMARY KEY,                  -- '30031' for Gallatin
  county_name              TEXT NOT NULL,
  state_code               TEXT NOT NULL REFERENCES states(state_code),
  usda_plant_location_id   INTEGER UNIQUE,                    -- USDA's id for the county
  centroid_lat             REAL,
  centroid_lon             REAL
);
CREATE INDEX idx_counties_state ON counties(state_code);


-- THE KILLER TABLE — plant × county × nativity.
-- Expected size at full nationwide ingest: ~1–5M rows.
-- Source: USDA plants/MapServer layer 6 (Counties), filtered to one state at a time.
CREATE TABLE plant_county_distribution (
  plant_id    INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  county_fips TEXT    NOT NULL REFERENCES counties(county_fips),
  nativity    TEXT    NOT NULL CHECK (nativity IN ('Native','Introduced','Both')),
  PRIMARY KEY (plant_id, county_fips)
);
CREATE INDEX idx_pcd_plant            ON plant_county_distribution(plant_id);
CREATE INDEX idx_pcd_county           ON plant_county_distribution(county_fips);
CREATE INDEX idx_pcd_county_nativity  ON plant_county_distribution(county_fips, nativity);


-- =====================================================================
-- SECTION 3 — USDA CHARACTERISTICS (wide table)
-- =====================================================================

-- USDA tracks ~83 named attributes across four categories. Only ~22% of
-- USDA plants have any characteristic data — but for those that do, the
-- full set is present. Wide format makes filter queries trivial:
--     SELECT * FROM plant_characteristics
--     WHERE drought_tolerance = 'High'
--       AND shade_tolerance   IN ('Tolerant','Intermediate')
--       AND temperature_min_f <= -20;
--
-- Boolean fields are stored as INTEGER 0/1 (SQLite has no bool).
-- Columns are grouped by USDA's PlantCharacteristicCategory for readability.
-- Source: USDA PlantCharacteristics tab. Wild-type only (CultivarName IS NULL).
CREATE TABLE plant_characteristics (
  plant_id INTEGER PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,

  ---- Morphology / Physiology ----
  active_growth_period               TEXT,                     -- 'Spring','Spring and Summer','Year Round',...
  c_n_ratio                          TEXT CHECK (c_n_ratio IN ('Low','Medium','High')),
  bloat                              TEXT CHECK (bloat IN ('None','Low','Medium','High')),
  coppice_potential                  INTEGER CHECK (coppice_potential IN (0,1)),
  fall_conspicuous                   INTEGER CHECK (fall_conspicuous IN (0,1)),
  fire_resistant                     INTEGER CHECK (fire_resistant IN (0,1)),
  flower_color                       TEXT,
  flower_conspicuous                 INTEGER CHECK (flower_conspicuous IN (0,1)),
  foliage_color                      TEXT,
  foliage_porosity_summer            TEXT CHECK (foliage_porosity_summer IN ('Dense','Moderate','Porous')),
  foliage_porosity_winter            TEXT CHECK (foliage_porosity_winter IN ('Dense','Moderate','Porous')),
  foliage_texture                    TEXT CHECK (foliage_texture IN ('Fine','Medium','Coarse')),
  fruit_color                        TEXT,
  fruit_conspicuous                  INTEGER CHECK (fruit_conspicuous IN (0,1)),
  growth_form                        TEXT,                     -- 'Single Stem','Multi Stem','Rhizomatous',...
  growth_rate                        TEXT CHECK (growth_rate IN ('Slow','Moderate','Rapid')),
  height_at_20_years_max_ft          REAL,
  height_mature_ft                   REAL,
  known_allelopath                   INTEGER CHECK (known_allelopath IN (0,1)),
  leaf_retention                     INTEGER CHECK (leaf_retention IN (0,1)),
  lifespan                           TEXT CHECK (lifespan IN ('Short','Moderate','Long')),
  low_growing_grass                  INTEGER CHECK (low_growing_grass IN (0,1)),
  nitrogen_fixation                  TEXT CHECK (nitrogen_fixation IN ('None','Low','Medium','High')),
  resprout_ability                   INTEGER CHECK (resprout_ability IN (0,1)),
  shape_and_orientation              TEXT,
  toxicity                           TEXT CHECK (toxicity IN ('None','Slight','Moderate','Severe')),

  ---- Growth Requirements ----
  adapted_to_coarse_textured_soils   INTEGER CHECK (adapted_to_coarse_textured_soils IN (0,1)),
  adapted_to_medium_textured_soils   INTEGER CHECK (adapted_to_medium_textured_soils IN (0,1)),
  adapted_to_fine_textured_soils     INTEGER CHECK (adapted_to_fine_textured_soils IN (0,1)),
  anaerobic_tolerance                TEXT CHECK (anaerobic_tolerance IN ('None','Low','Medium','High')),
  caco3_tolerance                    TEXT CHECK (caco3_tolerance IN ('None','Low','Medium','High')),
  cold_stratification_required       INTEGER CHECK (cold_stratification_required IN (0,1)),
  drought_tolerance                  TEXT CHECK (drought_tolerance IN ('None','Low','Medium','High')),
  fertility_requirement              TEXT CHECK (fertility_requirement IN ('Low','Medium','High')),
  fire_tolerance                     TEXT CHECK (fire_tolerance IN ('None','Low','Medium','High')),
  frost_free_days_min                INTEGER,
  hedge_tolerance                    TEXT CHECK (hedge_tolerance IN ('None','Low','Medium','High')),
  moisture_use                       TEXT CHECK (moisture_use IN ('Low','Medium','High')),
  ph_min                             REAL,
  ph_max                             REAL,
  planting_density_min_per_acre      INTEGER,
  planting_density_max_per_acre      INTEGER,
  precipitation_min_in               REAL,
  precipitation_max_in               REAL,
  root_depth_min_in                  INTEGER,
  salinity_tolerance                 TEXT CHECK (salinity_tolerance IN ('None','Low','Medium','High')),
  shade_tolerance                    TEXT CHECK (shade_tolerance IN ('None','Low','Medium','High')),
  temperature_min_f                  REAL,

  ---- Reproduction ----
  bloom_period                       TEXT,                     -- USDA: 'Early Spring','Mid Spring','Late Spring','Summer','Fall',...
  commercial_availability            TEXT,                     -- 'Routinely Available','Contracting Only','No Known Source','Field Collections Only' (CHECK omitted until full vocab confirmed)
  fruit_seed_abundance               TEXT CHECK (fruit_seed_abundance IN ('None','Low','Medium','High')),
  fruit_seed_period_begin            TEXT,
  fruit_seed_period_end              TEXT,
  fruit_seed_persistence             INTEGER CHECK (fruit_seed_persistence IN (0,1)),
  propagated_by_bare_root            INTEGER CHECK (propagated_by_bare_root IN (0,1)),
  propagated_by_bulb                 INTEGER CHECK (propagated_by_bulb IN (0,1)),
  propagated_by_container            INTEGER CHECK (propagated_by_container IN (0,1)),
  propagated_by_corm                 INTEGER CHECK (propagated_by_corm IN (0,1)),
  propagated_by_cuttings             INTEGER CHECK (propagated_by_cuttings IN (0,1)),
  propagated_by_seed                 INTEGER CHECK (propagated_by_seed IN (0,1)),
  propagated_by_sod                  INTEGER CHECK (propagated_by_sod IN (0,1)),
  propagated_by_sprigs               INTEGER CHECK (propagated_by_sprigs IN (0,1)),
  propagated_by_tubers               INTEGER CHECK (propagated_by_tubers IN (0,1)),
  seed_per_pound                     INTEGER,
  seed_spread_rate                   TEXT CHECK (seed_spread_rate IN ('None','Slow','Moderate','Rapid')),
  seedling_vigor                     TEXT CHECK (seedling_vigor IN ('Low','Medium','High')),
  small_grain                        INTEGER CHECK (small_grain IN (0,1)),
  vegetative_spread_rate             TEXT CHECK (vegetative_spread_rate IN ('None','Slow','Moderate','Rapid')),

  ---- Suitability / Use ----
  berry_nut_seed_product             INTEGER CHECK (berry_nut_seed_product IN (0,1)),
  christmas_tree_product             INTEGER CHECK (christmas_tree_product IN (0,1)),
  fodder_product                     INTEGER CHECK (fodder_product IN (0,1)),
  fuelwood_product                   TEXT CHECK (fuelwood_product IN ('Low','Medium','High')),
  lumber_product                     INTEGER CHECK (lumber_product IN (0,1)),
  naval_store_product                INTEGER CHECK (naval_store_product IN (0,1)),
  nursery_stock_product              INTEGER CHECK (nursery_stock_product IN (0,1)),
  palatable_browse_animal            TEXT CHECK (palatable_browse_animal IN ('Low','Medium','High')),
  palatable_graze_animal             TEXT CHECK (palatable_graze_animal IN ('Low','Medium','High')),
  palatable_human                    INTEGER CHECK (palatable_human IN (0,1)),
  post_product                       INTEGER CHECK (post_product IN (0,1)),
  protein_potential                  TEXT CHECK (protein_potential IN ('Low','Medium','High')),
  pulpwood_product                   INTEGER CHECK (pulpwood_product IN (0,1)),
  veneer_product                     INTEGER CHECK (veneer_product IN (0,1))
);

-- Indexes for the high-frequency filter columns. Add others as queries
-- demand them; over-indexing hurts INSERT throughput at ingest.
CREATE INDEX idx_pc_drought          ON plant_characteristics(drought_tolerance);
CREATE INDEX idx_pc_shade            ON plant_characteristics(shade_tolerance);
CREATE INDEX idx_pc_moisture         ON plant_characteristics(moisture_use);
CREATE INDEX idx_pc_temp_min         ON plant_characteristics(temperature_min_f);
CREATE INDEX idx_pc_bloom            ON plant_characteristics(bloom_period);
CREATE INDEX idx_pc_commercial_avail ON plant_characteristics(commercial_availability);
CREATE INDEX idx_pc_lifespan         ON plant_characteristics(lifespan);
CREATE INDEX idx_pc_height_mature    ON plant_characteristics(height_mature_ft);


-- =====================================================================
-- SECTION 4 — ENRICHMENTS (long tables)
-- =====================================================================

-- Wildlife food/cover ratings. Sparse — only ~4% of plants nationally.
-- Multiple source references per plant (Martin, Quinlan, etc.).
-- Source: USDA PlantWildlife tab.
CREATE TABLE plant_wildlife_value (
  plant_id            INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  use_type            TEXT    NOT NULL CHECK (use_type IN ('Food','Cover')),
  source_reference    TEXT    NOT NULL,
  large_mammals       TEXT    CHECK (large_mammals       IN ('','Minor','Low','Moderate','High')),
  small_mammals       TEXT    CHECK (small_mammals       IN ('','Minor','Low','Moderate','High')),
  water_birds         TEXT    CHECK (water_birds         IN ('','Minor','Low','Moderate','High')),
  terrestrial_birds   TEXT    CHECK (terrestrial_birds   IN ('','Minor','Low','Moderate','High')),
  PRIMARY KEY (plant_id, use_type, source_reference)
);


-- Per-region wetland indicator codes. ~41% of plants have entries.
-- Source: USDA PlantWetland tab.
CREATE TABLE plant_wetland_indicators (
  plant_id      INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  region        TEXT    NOT NULL,        -- 'Arid West','Midwest','Great Plains',...
  sub_region    TEXT,
  wetland_code  TEXT    NOT NULL CHECK (wetland_code IN ('OBL','FACW','FAC','FACU','UPL','NL')),
  PRIMARY KEY (plant_id, region, sub_region)
);
CREATE INDEX idx_pwi_code ON plant_wetland_indicators(wetland_code);


-- USDA-tracked taxonomic synonyms. Resolves "Anemone patens" → "Pulsatilla patens"
-- when USDA documents that relationship (note: USDA misses cross-genus
-- reclassifications like Pulsatilla itself; GBIF backbone catches those).
-- Source: USDA PlantSynonyms tab.
CREATE TABLE plant_synonyms (
  accepted_plant_id        INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  synonym_usda_symbol      TEXT    NOT NULL,
  synonym_scientific_name  TEXT    NOT NULL,
  PRIMARY KEY (accepted_plant_id, synonym_usda_symbol)
);
CREATE INDEX idx_synonyms_symbol ON plant_synonyms(synonym_usda_symbol);


-- Conservation / regulatory status per state.
-- One row per (plant, status_type, state, value). USDA returns these via
-- PlantLegalStatus, PlantInvasiveStatus, PlantNoxiousStatus.
CREATE TABLE plant_status (
  plant_id        INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  status_type     TEXT    NOT NULL CHECK (status_type IN ('Legal','Invasive','Noxious','Protected','Conservation')),
  locality_type   TEXT    NOT NULL CHECK (locality_type IN ('Federal','State','County','International')),
  locality_name   TEXT    NOT NULL,        -- 'Alabama','U.S. Federal',...
  status_value    TEXT    NOT NULL,        -- 'Watch List','Class C','S1',...
  PRIMARY KEY (plant_id, status_type, locality_type, locality_name, status_value)
);
CREATE INDEX idx_status_locality ON plant_status(status_type, locality_name);


-- External references USDA provides per plant: cross-database links + cited
-- data sources. Useful for the website's "learn more" links.
-- Source: USDA PlantRelatedLinks + PlantDocumentation tabs.
CREATE TABLE plant_external_references (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id           INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  reference_type     TEXT    NOT NULL CHECK (reference_type IN ('related_link','documentation')),
  ref_label          TEXT,
  ref_url            TEXT,
  ref_citation       TEXT,                  -- for documentation entries
  ref_data_source_type TEXT,                -- e.g. 'Distribution','Wildlife','Wetland'
  ref_locality       TEXT                   -- e.g. 'California','Alaska'
);
CREATE INDEX idx_per_plant ON plant_external_references(plant_id);
CREATE INDEX idx_per_type  ON plant_external_references(plant_id, reference_type);


-- =====================================================================
-- SECTION 5 — FULL-TEXT SEARCH
-- =====================================================================

-- FTS5 mirror of plant names. Used for /search?q=... endpoints.
CREATE VIRTUAL TABLE plants_fts USING fts5(
  scientific_name,
  scientific_name_canonical,
  common_name,
  family,
  genus,
  content='plants',
  content_rowid='id'
);

CREATE TRIGGER plants_ai AFTER INSERT ON plants BEGIN
  INSERT INTO plants_fts(rowid, scientific_name, scientific_name_canonical, common_name, family, genus)
  VALUES (new.id, new.scientific_name, new.scientific_name_canonical, new.common_name, new.family, new.genus);
END;

CREATE TRIGGER plants_ad AFTER DELETE ON plants BEGIN
  INSERT INTO plants_fts(plants_fts, rowid, scientific_name, scientific_name_canonical, common_name, family, genus)
  VALUES('delete', old.id, old.scientific_name, old.scientific_name_canonical, old.common_name, old.family, old.genus);
END;

CREATE TRIGGER plants_au AFTER UPDATE ON plants BEGIN
  INSERT INTO plants_fts(plants_fts, rowid, scientific_name, scientific_name_canonical, common_name, family, genus)
  VALUES('delete', old.id, old.scientific_name, old.scientific_name_canonical, old.common_name, old.family, old.genus);
  INSERT INTO plants_fts(rowid, scientific_name, scientific_name_canonical, common_name, family, genus)
  VALUES (new.id, new.scientific_name, new.scientific_name_canonical, new.common_name, new.family, new.genus);
END;


-- =====================================================================
-- SCHEMA METADATA
-- =====================================================================

CREATE TABLE schema_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO schema_meta (key, value, updated_at) VALUES
  ('schema_version', '001', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('migration',      '001_initial', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
