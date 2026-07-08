# rootfast

A free, public-domain plant API and the website that browses it.

- **API** — https://api.rootfast.org · interactive docs at `/v1/docs`, spec at `/v1/openapi.json`
- **Web** — https://rootfast.org
- **License** — MIT (code) + CC0 1.0 (data). See [LICENSE](LICENSE).

## What rootfast is

Rootfast answers a simple question — *I live here, what should I plant?* — and
answers it with data, not opinion. We join several pieces of beautiful public
infrastructure into one queryable surface so downstream tools don't have to.

| Source | What we use it for |
|---|---|
| **USDA PLANTS Database** | Taxonomy, county-level distribution, native/introduced status, cultivation characteristics |
| **USDA-ARS Plant Hardiness Zone Map (2023)** | ZIP → zone and county → zone lookups |
| **GBIF Backbone Taxonomy** | The cross-source join key (`gbif_taxon_key` on every plant) |
| **iNaturalist** | Hot-linked CC-licensed species photos |

Everything is public domain or CC0. No keys, no commercial gating, no terms
beyond attribution.

## Status

| Metric | Value |
|---|---|
| Plant taxa | **27,678** |
| States & territories | **55 / 56** (Connecticut pending USDA republish after their 2022 county abolition) |
| Counties | **3,230** |
| Distribution records | **2,501,631** (plant × county × nativity) |
| Hardiness ZIPs | **40,502** |
| Counties with hardiness zone | **3,199 / 3,227** |
| GBIF match coverage | **100 %** |
| iNaturalist photos | **26,125** (94 %) |
| Schema version | **005** |

## Repo layout

```
rootfast/
├── api/                      Cloudflare Worker + D1 schema + build scripts
│   ├── src/                  TypeScript Worker (Hono-free, raw fetch handler)
│   │   ├── index.ts          Routes, rate-limit middleware, JSON helpers
│   │   └── openapi.ts        Hand-maintained OpenAPI 3.0 spec
│   ├── schema/               SQLite-dialect D1 migrations
│   │   ├── 001_initial.sql   Core schema (plants, counties, distribution, …)
│   │   ├── 002_photos.sql    iNaturalist photo columns
│   │   ├── 003_hardiness.sql Hardiness zones (zones / by_zip / by_county)
│   │   ├── 004_wetland_index.sql  Wetland-indicator index
│   │   └── 005_soil.sql      SSURGO soil profile per county
│   ├── scripts/              Build + push tooling
│   │   ├── build.py          Merge source SQLite chunks → unified rootfast.db
│   │   ├── build_chunks.py   Split data dump into 4 MB chunks (D1 push)
│   │   └── push_chunks.sh    Idempotent retry-loop wrangler push
│   └── wrangler.toml         Worker config + D1 + rate-limit bindings
├── sources/                  One folder per upstream
│   ├── usda-plants/etl/      Per-state distribution + profiles + tabs + GBIF + iNat
│   └── usda-hardiness/etl/   PHZM 2023: ZIP table + per-state polygons + county PIP
├── web/                      Astro 4 SSR on Cloudflare Pages
│   └── src/pages/            Home, /plants, /counties, /states, /search, /docs, /about, /explore
├── docs/                     Project-wide design notes
├── experimental/montana/     Sidelined MT-specific work (kept for reference)
├── LICENSE                   MIT (code) + CC0 (data)
├── README.md                 (you are here)
└── native-plant-finder-api.md  Original project pitch
```

## Architecture in one diagram

```
┌─────────────────────────┐
│ sources/usda-plants     │──┐
│ (per-state fetch        │  │
│  + GBIF + iNat enrich)  │  │  source chunks
└─────────────────────────┘  │  (SQLite)
                             ├─→  api/scripts/build.py  ─→  rootfast.db  ─→  D1
┌─────────────────────────┐  │                                                  │
│ sources/usda-hardiness  │──┘                                                   ▼
│ (PHZM ZIP + county PIP) │                                              api/  (Cloudflare Worker)
└─────────────────────────┘                                                     │
                                                                                ▼
                                                                          web/  (Astro on Pages)
```

Each ETL pipeline emits a SQLite chunk matching the unified schema. The build
job merges chunks on `gbif_taxon_key`, runs FK + integrity checks, and emits a
data-only SQL dump split into ~4 MB chunks for D1's import path.

## Quick start

### Hit the live API

```bash
curl https://api.rootfast.org/v1/plants/PIPO         # ponderosa pine, full detail
curl https://api.rootfast.org/v1/hardiness/zip/59715  # Bozeman, MT
curl 'https://api.rootfast.org/v1/search?q=ponderosa'
```

### Run the Worker locally

```bash
cd api
npm install
npx wrangler dev --remote   # serves on http://localhost:8787, queries production D1
```

### Run the website locally

```bash
cd web
npm install
npm run dev
```

The site reads from `PUBLIC_API_BASE_URL` (defaults to `https://api.rootfast.org`).
Point it at your local Worker if you're iterating on both.

### Rebuild the dataset from upstream

```bash
# 1. USDA per-state fetch (parameterized; resumes from cache)
cd sources/usda-plants/etl
python3 scripts/fetch_usda_plants.py MT
python3 scripts/fetch_usda_plants_tabs.py        # cultivation tabs
python3 scripts/match_gbif.py                    # GBIF backbone match
python3 scripts/fetch_inat_photos.py             # iNat photo enrichment

# 2. USDA hardiness fetch (nationwide in one shot)
cd ../../usda-hardiness/etl
python3 scripts/fetch_hardiness.py

# 3. Emit per-source SQLite chunks
python3 sources/usda-plants/etl/scripts/build_sqlite.py
python3 sources/usda-hardiness/etl/scripts/build_sqlite.py

# 4. Merge → unified DB → chunked SQL → push to D1
python3 api/scripts/build.py
python3 api/scripts/build_chunks.py
api/scripts/push_chunks.sh
```

The fetch scripts are idempotent — re-running picks up only what's missing.
Raw caches live under `sources/*/etl/raw/` and are gitignored; small reference
files (states.json, state_polygons.json) are checked in.

## Data sources, in detail

Discovery paths and gotchas for each upstream are documented in
[`sources/usda-plants/docs/SOURCES.md`](sources/usda-plants/docs/SOURCES.md).
Highlights:

- USDA PLANTS's distribution layer uses two distinct `plant_location_id`
  spaces — you cannot join the ArcGIS layer to the PlantsService API by ID.
  We work around this with spatial polygon queries.
- PHZM's "downloads" page is a misleading red herring (PNG/PDF only). The
  real data is in two ArcGIS FeatureServices the interactive map uses.
- Connecticut abolished its 8 counties in 2022 and replaced them with 9
  planning regions. USDA has the new boundaries but no plant records linked
  to them yet — see SOURCES.md.

## Contributing

Issues, ideas, corrections, requests for specific regions — welcome. Rootfast
is a quiet public-interest project. If you find a bug in the data, please
open an issue with the USDA symbol or county FIPS so we can reproduce.

## Credits

- USDA Natural Resources Conservation Service for PLANTS
- USDA Agricultural Research Service for the Plant Hardiness Zone Map
- GBIF for the Backbone Taxonomy
- iNaturalist photographers — each photo's individual CC license is preserved
- Cloudflare's free tier (Workers, D1, Pages) for hosting the whole thing
