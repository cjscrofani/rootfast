# sources/usda-plants/

**USDA PLANTS data ingestion pipeline** for the Rootfast API.

Python ETL that fetches USDA's public plant data, enriches it with GBIF
Backbone taxon keys and iNaturalist photos, and produces a SQLite chunk
consumed by the Rootfast API's build/merge step.

## Scope

Every plant in the USDA PLANTS database, plus its per-county distribution,
nativity, characteristics, wildlife use, wetland indicators, synonyms,
subordinate taxa, classification, and external references.

Public domain (federal data).

## Structure

```
sources/usda-plants/
├── etl/
│   ├── scripts/                            CLI entry points
│   │   ├── fetch_usda_plants.py            Per-state distribution + profile cache (parameterized)
│   │   ├── fetch_usda_plants_tabs.py       Per-plant tab fetcher (idempotent)
│   │   ├── match_gbif.py                   GBIF Backbone match for each plant
│   │   ├── fetch_inat_photos.py            iNat photo enrichment (rate-limited ~85/min)
│   │   └── build_sqlite.py                 Emits processed/usda_plants.db
│   ├── src/rootfast/                       Legacy loaders / package (largely unused now)
│   ├── raw/                                Upstream caches (gitignored except small seeds)
│   │   ├── states.json                     Committed: 56 states + territories
│   │   ├── state_polygons.json             Committed: per-state polygon for spatial filter
│   │   ├── mt_polygon.json                 Committed: MT polygon (proof-case)
│   │   └── ...everything else gitignored
│   └── processed/                          Built usda_plants.db (gitignored)
├── docs/
│   ├── SOURCES.md                          Discovery, provenance, USDA gotchas, CT note
│   ├── USDA_PLANTS_EXPLORATION.md          Notebook-style endpoint exploration
│   └── EXAMPLE_SPECIES_*.md                Worked examples (PIPO, JUCO6)
└── README.md
```

## Status

| | |
|---|---|
| States + territories ingested | **55 / 56** (Connecticut pending USDA republish) |
| Plant taxa in chunk | **27,678** |
| Distribution rows | **2,501,631** |
| GBIF match | **100 %** |
| iNaturalist photos | **94 %** |

## Build the SQLite chunk from scratch

```bash
cd sources/usda-plants/etl

# 1. Per-state distribution + PlantProfile fetch (idempotent, resumable)
python3 scripts/fetch_usda_plants.py MT   # one state at a time, or loop
# (repeat for every USPS code in states.json)

# 2. Per-plant cultivation/characteristic tabs (one-time pass across all cached profiles)
python3 scripts/fetch_usda_plants_tabs.py

# 3. GBIF Backbone taxon-key match
python3 scripts/match_gbif.py

# 4. iNaturalist photo enrichment (rate-limited; can be re-run for backfill)
python3 scripts/fetch_inat_photos.py

# 5. Emit the SQLite chunk for the API merge step
python3 scripts/build_sqlite.py     # → processed/usda_plants.db
```

Each step caches under `raw/` and skips already-cached entries — running any
script twice is safe.

## Discovery notes

See `docs/SOURCES.md` for the full upstream provenance. Three things worth
flagging up front:

1. **Two `plant_location_id` spaces.** USDA's ArcGIS distribution layer and
   their PlantsService REST API use different id systems for the same county.
   We join by `country_subdivision_name` instead, then resolve to FIPS via a
   separately-built counties registry.

2. **USDA's `/characteristicSearchResults` endpoint is NOT the master list.**
   It returns ~2,200 entries even nationwide — filtered to species-rank
   primary taxa. The authoritative full set is reachable only via per-state
   distribution queries followed by per-taxon PlantProfile fetches.

3. **Connecticut data gap (validated 2026-05-26).** USDA replaced CT's 8
   abolished counties with 9 planning regions in their gazetteer but hasn't
   linked any plant records to them yet. See `docs/SOURCES.md` for the full
   diagnosis + fallback options (GBIF Occurrences, Go Botany, CT DEEP).
