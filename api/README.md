# api — Rootfast API

The single API for rootfast. Cloudflare Worker queries a D1 database populated
by source ingestion pipelines under `../sources/`.

- **Live:** https://api.rootfast.org
- **Interactive docs:** https://api.rootfast.org/v1/docs (Scalar)
- **OpenAPI 3.0 spec:** https://api.rootfast.org/v1/openapi.json

## Layout

```
api/
├── schema/                       D1 migrations (SQLite dialect)
│   ├── 001_initial.sql           Core: plants, counties, distribution, characteristics, FTS5
│   ├── 002_photos.sql            iNaturalist photo columns
│   ├── 003_hardiness.sql         Hardiness zones (zones / by_zip / by_county)
│   └── README.md                 Schema design rationale
├── src/
│   ├── index.ts                  Worker — routing, rate limits, JSON helpers
│   └── openapi.ts                Hand-maintained OpenAPI 3.0 spec
├── scripts/                      Build + push tooling
│   ├── build.py                  Merge source chunks → unified rootfast.db
│   ├── build_chunks.py           Split data dump into ~4 MB chunks (D1 push)
│   ├── push_chunks.sh            Idempotent sequential wrangler push with retries
│   ├── build_hardiness_only.py   Tiny targeted hardiness-table refresh
│   └── build_vi_only.py          VI delta example (kept for reference)
├── processed/                    Build artefacts — gitignored
├── wrangler.toml                 D1 + 3 rate-limit bindings + custom domain
└── README.md
```

## Endpoints

19 paths under `/v1/*` (plus `/healthz`). See the OpenAPI spec for the full
schema; highlights:

| Path | What it does |
|---|---|
| `/healthz` | Service health, dataset + schema versions |
| `/v1/plants/{usda_symbol}` | Full plant detail (identity, growth habits, characteristics, counties, photo) |
| `/v1/plants?{filters}` | Filtered/paginated list; `format=csv|ndjson` for bulk export |
| `/v1/plants/by-gbif/{taxon_key}` | Lookup by GBIF Backbone key |
| `/v1/plants/random` | Random taxon (rotating short edge cache) |
| `POST /v1/plants/search` | JSON-body finder (same §F filter surface as GET) |
| `/v1/counties/{fips}/plants` | Plants recorded in a county |
| `/v1/states[/{code}[/{plants,counties}]]` | State headers, listings, breakdowns |
| `/v1/search?q=` | FTS5 over scientific + common names + family + genus |
| `/v1/hardiness/zones[/{code}]` | USDA PHZM 2023 zone reference |
| `/v1/hardiness/zip/{zip}` | ZIP → zone |
| `/v1/hardiness/county/{fips}` | County → predominant zone |
| `/v1/openapi.json` | OpenAPI 3.0 spec (this surface, machine-readable) |
| `/v1/docs` | Scalar interactive docs (renders `/v1/openapi.json`) |

## Rate limits (per client IP, 60-second windows)

| Tier | Routes | Limit |
|---|---|---|
| Default | most `/v1/*` | 120 req/min |
| Search | `/v1/search`, `POST /v1/plants/search` | 60 req/min |
| Bulk | `?format=csv` or `?format=ndjson` | 5 req/min |

`/healthz`, `/v1/openapi.json`, `/v1/docs` are not rate-limited. A 429
response carries `Retry-After: 60` and a `tier` field naming which limiter
rejected the request.

## Build & push flow

```bash
# 1. Source pipelines emit SQLite chunks
python3 ../sources/usda-plants/etl/scripts/build_sqlite.py
python3 ../sources/usda-hardiness/etl/scripts/build_sqlite.py

# 2. Merge into the unified DB + write data-only SQL
python3 scripts/build.py
# → processed/rootfast.db         (binary, for inspection)
# → processed/rootfast.sql        (full dump)
# → processed/rootfast_data.sql   (data-only, for D1 push)

# 3. Split into ~4 MB chunks and push
python3 scripts/build_chunks.py            # → processed/chunks/*.sql
scripts/push_chunks.sh                     # idempotent, retries each chunk 4x
```

The chunked push exists because wrangler's R2-upload path is brittle for
files > a few MB under Node 25 — see comments in `scripts/push_chunks.sh`.
INSERT statements use `INSERT OR IGNORE` so retries after a partial upload
don't trip the UNIQUE constraints.

## Deploy the Worker

```bash
npm install
npx wrangler deploy
```

## One-time D1 setup (already done; for reference)

```bash
npx wrangler d1 create rootfast       # prints database_id; paste into wrangler.toml
npx wrangler d1 execute rootfast --remote --file=schema/001_initial.sql --yes
npx wrangler d1 execute rootfast --remote --file=schema/002_photos.sql --yes
npx wrangler d1 execute rootfast --remote --file=schema/003_hardiness.sql --yes
```

## Local dev

```bash
npm run dev                           # wrangler dev — local Worker against local D1
curl localhost:8787/healthz
curl localhost:8787/v1/plants/PIPO
```

To run against the *remote* D1 from a local Worker (handy when iterating on
endpoint code without rebuilding D1 locally):

```bash
npx wrangler dev --remote
```

## Status

- **Schema** v003 (hardiness landed on top of plants + photos)
- **Endpoints** 19 paths live, OpenAPI 3.0 spec served at `/v1/openapi.json`
- **Rate limits** in place (3 tiers, generous defaults)
- **Data** 27,678 taxa · 2.5M distribution rows · 26,125 photos · 40,502 ZIP zones · 3,199 county zones
