# sources/usda-soil/

**USDA-NRCS Soil Data Access (SSURGO) ingestion pipeline** for the Rootfast API.

Python ETL that samples the soil at every US county centroid via the
USDA Soil Data Access REST endpoint and produces a per-county soil
summary consumed by the Rootfast API's build/merge step.

## Scope

A single representative soil profile per US county, weighted by component
percentage within the centroid's map unit. Surfaces what's typical at the
centroid, not the full distribution across the county.

For per-address soil lookups we would need to call SDA at request time
(point → mukey → components), which is out of scope for the v1 county
summary.

## Structure

```
sources/usda-soil/
├── etl/
│   ├── scripts/
│   │   ├── fetch_soil.py     Bulk point→mukey + per-mukey component/horizon fetch via SDA
│   │   └── build_sqlite.py   Aggregates to a single row per county, emits processed/soil.db
│   ├── raw/                  Cached SDA responses (gitignored)
│   └── processed/            Built soil.db (gitignored)
└── README.md
```

## Source

USDA-NRCS Soil Data Access (SDA) — public REST endpoint at
`https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest`. Accepts SQL
SELECT bodies, returns JSON. Powered by SSURGO (Soil Survey Geographic
database).

Documentation:
- https://sdmdataaccess.nrcs.usda.gov/WebServiceHelp.aspx
- https://sdmdataaccess.nrcs.usda.gov/

Public domain federal data.

## Pipeline

```bash
cd sources/usda-soil/etl

# 1. Fetch — uses each county centroid (read from usda_plants.db) and SDA
#    to resolve a mukey, then pulls components + horizons in bulk batches.
python3 scripts/fetch_soil.py

# 2. Aggregate to a single representative profile per county and emit chunk.
python3 scripts/build_sqlite.py    # → processed/soil.db
```

The fetch script is idempotent. Re-running picks up only counties missing
from `raw/county_soil/{fips}.json`.

## Schema

Owns one table in the unified D1 (see `api/schema/005_soil.sql`):

- `soil_by_county` — one row per US county, joined to `counties` via FIPS.
  Columns: mukey, muname, dominant_comp, drainage_class, slope_pct,
  surface_ph, surface_om_pct, sand/silt/clay percentages, texture_class
  (USDA triangle), awc_in_top_25cm.

## Caveats

- One mukey sampled per county centroid — loses sub-county soil variation.
  Hawaii, Alaska, and water-heavy coastal counties may centroid into a
  null soil map unit.
- Component-percentage weighting collapses minor components; rare-but-
  important soils (e.g. small wetland inclusions) won't show up.
- USDA SSURGO certifications differ by state — some lag others.
