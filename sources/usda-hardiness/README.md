# sources/usda-hardiness/

**USDA Plant Hardiness Zone ingestion pipeline** for the Rootfast API.

Not a standalone API — a data source that the Rootfast API joins in alongside
USDA PLANTS, surfaced through `/v1/hardiness/{zones,zip,county}` endpoints.

## Source

USDA-ARS 2023 Plant Hardiness Zone Map. Different upstream service than USDA
PLANTS (different agency, decadal update cadence vs annual), hence its own
pipeline.

## What's here

```
sources/usda-hardiness/
├── etl/
│   ├── scripts/
│   │   ├── fetch_hardiness.py     Nationwide: ZIP table + per-state polygons + county PIP
│   │   ├── fetch_hardiness_mt.py  Original MT-only version (kept for reference)
│   │   └── build_sqlite.py        Emits processed/hardiness.db for the API merge
│   ├── raw/                       Fetched data (gitignored; regenerable)
│   │   ├── zones/{XX}.geojson     Per-state PHZM polygons (~150 MB total)
│   │   ├── zip_zones.csv          40,502 ZIPs → zone (~2 MB)
│   │   └── county_zones.csv       3,199 counties → predominant zone
│   ├── processed/                 Built hardiness.db (gitignored)
│   └── src/usdahardiness/         Legacy loader (unused; kept for reference)
└── README.md
```

## How to rebuild

```bash
cd sources/usda-hardiness/etl
python3 scripts/fetch_hardiness.py        # 3 steps: ZIP table, polygons, county PIP
python3 scripts/build_sqlite.py           # → processed/hardiness.db
```

The fetch script is idempotent — re-running picks up only missing pieces.

## Schema

The pipeline owns three tables in the unified D1 (see `api/schema/003_hardiness.sql`):

- `hardiness_zones` — 26-row canonical reference (1a..13b, temp ranges)
- `hardiness_zones_by_zip` — 40,502 rows, ZIP → zone
- `hardiness_zones_by_county` — 3,199 rows, county FIPS → predominant zone

County zones are derived by sampling each county centroid against the PHZM
polygon layer. The 28 counties without a zone are in territories USDA doesn't
cover (AS, MP) or have water-heavy geometries whose vertex-mean centroid lands
outside the polygons.

## Upstream discovery

The official downloads page at planthardiness.ars.usda.gov is PNG-only — a
red herring. The real data lives in two ArcGIS FeatureServices on
`services1.arcgis.com` host `SyUSN23vOoYdfLC8`, discoverable via the public
ArcGIS Experience config at
`arcgis.com/sharing/rest/content/items/b1d1fd9b284e46dcaa43959bec439b44/data?f=json`:

- **`PHZM_2023_Zip_Code_Table`** — 40,502 rows, ZIP → zone Class
  - **Gotcha:** the `ZONE_CODE` field is an opaque internal id, not "5a"-style.
    Use the integer `Class_Code` (1=1a, …, 26=13b) to map back.
- **`PHZM_Links_with_zones`** layer 6 — state × zone polygons (371 features)
  - Best for arbitrary lat/lng → zone via point-in-polygon
  - Bulky for direct API use (e.g. MT alone is ~7.5 MB GeoJSON)
