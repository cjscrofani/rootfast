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
│   ├── 004_wetland_index.sql     Wetland-indicator index
│   ├── 005_soil.sql              SSURGO soil profile per county
│   ├── 006_summaries.sql         Precomputed endemic + county-taxa summaries
│   ├── 007_zip_counties.sql      ZIP → county crosswalk (Census ZCTA)
│   ├── 008_read_cost.sql         Read-cost summaries, usage ledger, response store
│   └── README.md                 Schema design rationale
├── src/
│   ├── index.ts                  Worker — routing, rate limits, JSON helpers
│   ├── guard.ts                  Cost guards — cache keys, row metering, daily budget, response store
│   └── openapi.ts                Hand-maintained OpenAPI 3.0 spec
├── scripts/                      Build + push tooling
│   ├── build.py                  Merge source chunks → unified rootfast.db
│   ├── populate_summaries.sql    Refill the 006 + 008 summary tables
│   ├── populate_meta.sql         Stamp dataset date/version/counts into schema_meta (/healthz)
│   ├── build_chunks.py           Split data dump into ~4 MB chunks (D1 push)
│   ├── push_chunks.sh            Idempotent sequential wrangler push with retries
│   ├── build_hardiness_only.py   Tiny targeted hardiness-table refresh
│   └── build_vi_only.py          VI delta example (kept for reference)
├── processed/                    Build artefacts — gitignored
├── wrangler.toml                 D1 + 3 rate-limit bindings + custom domain
└── README.md
```

## Endpoints

27 paths under `/v1/*` (plus `/healthz`). See the OpenAPI spec for the full
schema; highlights:

| Path | What it does |
|---|---|
| `/healthz` | Health, dataset version + date, schema version, source pull dates, row counts |
| `/v1/zip/{zip}` | ZIP → counties (largest land share first) + hardiness zone |
| `/v1/zip/{zip}/plants` | Plants recorded in a ZIP's counties; §F filters, `scope=all\|primary`, bulk formats |
| `/v1/plants/{usda_symbol}` | Full plant detail (identity, growth habits, characteristics, counties, photo) |
| `/v1/plants?{filters}` | Filtered/paginated list; `format=csv|ndjson` for bulk export; `photo_license` / `has_photo` filters |
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
| Default | most `/v1/*` | 60 req/min |
| Search | `/v1/search` | 30 req/min |
| Bulk | `?format=csv` or `?format=ndjson` | 2 req/min |
| Finder | `POST /v1/plants/search` | 2 req/min |

`/healthz`, `/v1/openapi.json`, `/v1/docs` are not rate-limited. A 429
response carries `Retry-After: 60` and a `tier` field naming which limiter
rejected the request. Answers served from the edge cache are not counted, and
neither are the website's calls over its service binding. IPv6 clients are
counted per /64. `POST` is accepted on `/v1/plants/search` only.

Bulk exports return at most 10,000 rows per call (`BULK_MAX_ROWS`). The
response carries `X-Total-Count` and, while rows remain, a
`Link: <…>; rel="next"` header; or download the dataset release.

These per-IP limits bound one client. They do nothing about traffic spread
over many addresses, and the website's own calls are not limited here at all:
the total is bounded by the daily budget below, and requests are only stopped
*before* they count by a rule on the Cloudflare zone (see `docs/ROLLOUT.md`).

## Cost guards (D1 rows read)

D1 is metered by rows **read**. The Workers Free plan allows 5,000,000 a day,
100,000 rows written a day, and 500 MB per database. `src/guard.ts` keeps the
API's D1 usage inside that. It does **not** control the other free-plan
limits: 100,000 requests a day (shared with the website's Functions — no code
inside a Worker can cap how often it is invoked) and 10 ms CPU per request.

| Guard | What it does |
|---|---|
| Summary tables (006, 008) | The hot listings read tens or hundreds of rows instead of re-aggregating the 2.5M-row distribution table. |
| Edge cache | `fetch()` stores cacheable answers with the Cache API (Cloudflare does not cache a Worker's own output otherwise). Per location. |
| Cache keys | Built from the path and only the query parameters a handler reads, so `?x=123` cannot force a recomputation. |
| Response store | Answers that cost 2,000+ rows and are cacheable for a day or more are kept in the `response_cache` table (global) and served for one row. Trimmed to about 1,000 entries (at most ~64 MB). It never expires entries itself: it is cleared by `populate_summaries.sql` and retired by a version bump. |
| Daily budget | Every query's `rows_read` is added to `usage_daily` (reported per isolate every 50,000 rows or 2 minutes). Each request sets 60,000 rows aside before it runs (500,000 for the plant finder), so a burst cannot overshoot; a request refused only because of that gets `503 busy` with `Retry-After: 5`. At `DAILY_ROWS_BUDGET` (default 4,000,000) the API serves edge-cached and stored answers only and returns 503 `daily_budget_exhausted` for the rest until 00:00 UTC. |

The budget counts the Worker's own queries only. Anything run with wrangler
or in the dashboard, and the release export, is not counted — that is what
the 1,000,000-row margin under the plan limit is for. When the budget trips,
most uncached website pages show "temporarily unavailable" until 00:00 UTC.

`/healthz` shows today's figure under `usage`. `/v1` responses carry
`x-rootfast-cache: edge | store | miss`. To see which queries cost the most:

```bash
npx wrangler d1 insights rootfast --sort-by reads --sort-type sum --timePeriod 1d
```

When adding an endpoint, check its `rows_read` (`wrangler d1 execute ... --json`
prints it under `meta`) before deploying: a query that scans `plants` costs
27,678 rows and one that scans `plant_county_distribution` costs 2.5 million.

## Build & push flow

```bash
# 1. Source pipelines emit SQLite chunks
python3 ../sources/usda-plants/etl/scripts/build_sqlite.py
python3 ../sources/usda-hardiness/etl/scripts/build_sqlite.py

# 2. Merge into the unified DB + write data-only SQL
python3 scripts/build.py --tag data-v2026.07   # --tag optional; stamps dataset_version
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

## Applying migrations 006–008 to production D1

The code in `src/` expects the summary tables (006, 008), `zip_counties` (007)
and the `schema_meta` stamps. From `api/`, in this order:

```bash
npx wrangler d1 execute rootfast --remote --file=schema/006_summaries.sql --yes
npx wrangler d1 execute rootfast --remote --file=schema/007_zip_counties.sql --yes
npx wrangler d1 execute rootfast --remote --file=schema/008_read_cost.sql --yes
npx wrangler d1 execute rootfast --remote --file=processed/rootfast_zip_counties.sql --yes   # ~1 MB, INSERT OR IGNORE
npx wrangler d1 execute rootfast --remote --file=scripts/populate_summaries.sql --yes       # fills 006 + 008 tables; idempotent
npx wrangler d1 execute rootfast --remote --file=scripts/populate_meta.sql --yes
# then stamp the dataset tag by hand (build.py does this automatically on a full rebuild):
npx wrangler d1 execute rootfast --remote --yes --command \
  "INSERT INTO schema_meta (key,value,updated_at) VALUES ('dataset_version','2026.05',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
```

`processed/rootfast_zip_counties.sql` is regenerated by `build.py` (it is the
`zip_counties` slice of the data dump, already reconciled against `counties`).

The schema files are not re-runnable (`CREATE TABLE` / `ADD COLUMN` fail the
second time); the populate scripts are. `populate_summaries.sql` writes about
2.9 million rows (mostly `county_plants`), which is far more than the Workers
Free plan's 100,000 rows written per day — run it while the account has the
Paid plan's allowance, or load those tables from a `build.py` dump in chunks.
Re-run it after any data reload: the summaries are derived from the base
tables and go stale otherwise. Then bump `DATASET_VERSION` in `wrangler.toml`
(or `CACHE_EPOCH` in `src/index.ts`) and redeploy, so answers cached at the
edge from the old data are not served for another day. Deploy the Worker only
after the populate has finished: with empty summary tables the listings
answer `200` with zero rows, and those answers would be cached.

## Status

- **Schema** v008 (read-cost summaries + usage ledger on top of zip_counties, summaries, soil, wetland, hardiness, photos, core)
- **Endpoints** OpenAPI 3.0 document, version `1.2.0`, served at `/v1/openapi.json`
- **Rate limits** in place (4 tiers) plus a daily D1 row budget — see "Cost guards"
- **Data** see `/healthz` — the counts there are stamped by the build, not typed by hand
