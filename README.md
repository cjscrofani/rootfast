# rootfast — native plant API for the United States

A free, public-domain **native plant API** with **county-level USDA nativity**
for every US county, hardiness zones by ZIP and county, plants-by-ZIP-code
lookups, iNaturalist photos, and GBIF keys — plus the website that browses it.

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
| **US Census 2020 ZCTA crosswalk** | ZIP → county, so `/v1/zip/{zip}/plants` can answer "what grows here?" |
| **GBIF Backbone Taxonomy** | The cross-source join key (`gbif_taxon_key` on every plant) |
| **iNaturalist** | Hot-linked CC-licensed species photos |

Everything is public domain or CC0. No keys, no commercial gating, no terms
beyond attribution.

> **Maintainer note (2026-11-25):** the ZIP endpoints, migrations 006–008, the
> `/healthz` provenance fields below and the D1 cost guards are built but not
> yet rolled out to production. Apply order and commands:
> [`docs/ROLLOUT.md`](docs/ROLLOUT.md).

## Status

| Metric | Value |
|---|---|
| Plant taxa | **27,678** |
| States & territories | **55 / 56** (Connecticut pending USDA republish after their 2022 county abolition) |
| Counties | **3,230** |
| Distribution records | **2,501,631** (plant × county × nativity) |
| Hardiness ZIPs | **40,502** |
| Counties with hardiness zone | **3,199 / 3,227** |
| ZIPs resolving to a county | **33,478** |
| GBIF match coverage | **100 %** |
| iNaturalist photos | **26,125** (94 %) |
| Dataset version | **2026.05** (USDA pull 2026-05-26) |
| Schema version | **008** |

These numbers are also served live by [`/healthz`](https://api.rootfast.org/healthz),
which is where the website reads them from.

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
│   │   ├── 005_soil.sql      SSURGO soil profile per county
│   │   ├── 006_summaries.sql Precomputed endemic + county-taxa summaries
│   │   └── 007_zip_counties.sql   ZIP → county crosswalk
│   ├── scripts/              Build + push tooling
│   │   ├── build.py          Merge source SQLite chunks → unified rootfast.db
│   │   ├── populate_meta.sql Stamp dataset version/date/counts for /healthz
│   │   ├── build_chunks.py   Split data dump into 4 MB chunks (D1 push)
│   │   └── push_chunks.sh    Idempotent retry-loop wrangler push
│   └── wrangler.toml         Worker config + D1 + rate-limit bindings
├── sources/                  One folder per upstream
│   ├── usda-plants/etl/      Per-state distribution + profiles + tabs + GBIF + iNat
│   ├── usda-hardiness/etl/   PHZM 2023: ZIP table + per-state polygons + county PIP
│   ├── usda-soil/etl/        SSURGO soil profile per county
│   └── census-zcta/etl/      Census ZCTA → county crosswalk (ZIP lookups)
├── web/                      Astro 4 SSR on Cloudflare Pages
│   └── src/pages/            Home, /plants, /counties, /states, /search, /docs, /about, /explore
├── docs/                     Project-wide design notes
├── experimental/montana/     Sidelined MT-specific work (kept for reference)
├── CHANGELOG.md              API, schema, and dataset changes
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
curl https://api.rootfast.org/v1/zip/59715            # Bozeman, MT → counties + hardiness zone
curl 'https://api.rootfast.org/v1/zip/59715/plants?nativity=Native&growth_habit=Tree'
curl https://api.rootfast.org/v1/hardiness/zip/59715  # zone only
curl 'https://api.rootfast.org/v1/search?q=ponderosa'
```

**How county nativity works.** The `nativity` on every plant × county row is
USDA PLANTS's own per-county flag from its distribution layer, stored as-is
(`Both` when USDA lists a county under both flags). It is *not* derived from
the coarser regional `native_status` (L48, AK, HI, …) on the plant record.
State and ZIP listings roll county rows up to one value per taxon.

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

### Run the tests

```bash
cd api && npm test          # Vitest — filter parser, paging, formatters, ETag
python3 -m pytest tests/    # ETL transforms — soil aggregation, name reducers
```

CI (`.github/workflows/ci.yml`) runs the Worker typecheck + Vitest, the web
`astro check`, and the ETL pytest + a syntax-compile of every script on each
push and pull request.

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

# 2b. Census ZCTA → county crosswalk (one 6.5 MB file)
cd ../../census-zcta/etl
python3 scripts/fetch_zcta_counties.py

# 3. Emit per-source SQLite chunks
python3 sources/usda-plants/etl/scripts/build_sqlite.py
python3 sources/usda-hardiness/etl/scripts/build_sqlite.py
python3 sources/census-zcta/etl/scripts/build_sqlite.py

# 4. Merge → unified DB → chunked SQL → push to D1
python3 api/scripts/build.py --tag data-v2026.07   # stamps dataset_version; defaults to the USDA pull month
python3 api/scripts/build_chunks.py
api/scripts/push_chunks.sh
```

The fetch scripts are idempotent — re-running picks up only what's missing.
Raw caches live under `sources/*/etl/raw/` and are gitignored; small reference
files (states.json, state_polygons.json) are checked in.

### Cut a versioned dataset release

Heavy consumers should download a snapshot rather than paginate the API. Each
release ships the full SQLite database (gzipped) and a per-table Parquet set,
plus a `manifest.json` with row counts and sha256 checksums.

**Automated (recommended):** push a `data-v*` tag. The
[`Dataset release`](.github/workflows/release.yml) workflow exports production
D1, rebuilds `rootfast.db`, packages the artifacts, and publishes a GitHub
Release. It needs a `CLOUDFLARE_API_TOKEN` repo secret with D1 read
(`gh secret set CLOUDFLARE_API_TOKEN`) — the workflow fails without it.

```bash
git tag data-v2026.07 && git push origin data-v2026.07
```

**Manual / local** (you already have a built `rootfast.db`):

```bash
python api/scripts/export_release.py api/processed/rootfast.db api/processed/release --tag data-v2026.07
gh release create data-v2026.07 api/processed/release/* --title "Dataset data-v2026.07"
```

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

## Stability, versions, and who runs it

- **`/v1` is stable.** Fields are only added, never renamed or removed. A
  breaking change ships as `/v2`; `/v1` stays up for at least twelve months
  after, with a `Deprecation` header and a [CHANGELOG](CHANGELOG.md) entry.
- **Three versions, three meanings.** `/v1` is the API surface; the OpenAPI
  `info.version` (1.1.0) bumps on additive changes; `dataset_version` in
  `/healthz` is date-based (`YYYY.MM`) and matches the `data-v*` release tags.
- **Refresh cadence.** USDA PLANTS and iNaturalist are re-pulled at least
  twice a year, sooner when USDA publishes a notable change.
- **Maintainer.** [CJ Scrofani](https://github.com/cjscrofani). Issues are
  the fastest channel. The service runs inside Cloudflare's free tier; if
  traffic outgrows it the response is tighter anonymous limits plus free keys
  for heavy users, never a paywall on CC0 data. The last release on GitHub
  always outlives the service.

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
