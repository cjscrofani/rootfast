# Changelog

All notable changes to the Rootfast API, website, and dataset. The API follows
the stability policy in [`/docs#stability`](https://rootfast.org/docs#stability):
`/v1` only gains fields; breaking changes ship as `/v2` with `/v1` kept alive
for at least twelve months and a `Deprecation` header on every response.
Rate limits, page-size caps and the daily allowance are operational settings,
not part of that contract: they can change within `/v1`, and every change is
listed here.

Dataset releases are tagged `data-vYYYY.MM` and listed on the
[Releases](https://github.com/cjscrofani/rootfast/releases) page.

## Unreleased — not yet deployed; see `docs/ROLLOUT.md` for the apply order

### API
- **Added** `GET /v1/zip/{zip}` — a ZIP resolves to the county or counties it
  covers (US Census 2020 ZCTA crosswalk, largest land share first, with taxa
  counts) plus its USDA hardiness zone.
- **Added** `GET /v1/zip/{zip}/plants` — plants recorded in a ZIP's counties,
  aggregated per taxon with the state-style nativity rollup. Supports every §F
  filter, paging, `sort`, `scope=all|primary`, and `format=csv|ndjson`.
- **Added** `photo_license` and `has_photo` filter parameters on every plant
  listing, so commercial users can restrict to reusable photos.
- **Changed** `GET /healthz` now reports `dataset_date`, `api_version`,
  source pull dates, and headline row counts, all read from `schema_meta`.
  The existing `ok`, `dataset_version`, `schema_version` fields are unchanged.
- **Changed** `dataset_version` is now date-based (`YYYY.MM`) instead of `0.0.1`.
- OpenAPI document bumped to `1.2.0`; nativity derivation, the stability
  policy, and a named maintainer contact are now in the spec's `info` block.
- **Added** a daily database allowance. Every D1 query the API runs is
  metered; once the day's `DAILY_ROWS_BUDGET` (4,000,000 rows, 80% of the
  Workers Free limit) is spent, answers already cached are still served and
  everything else returns `503 daily_budget_exhausted` with `Retry-After`
  until 00:00 UTC. A `503 busy` with `Retry-After: 5` means the allowance is
  nearly spent and requests in flight hold the rest. **Clients should expect
  this new status.**
- **Added** `usage` on `GET /healthz` (today's rows read, the budget, whether
  it is exhausted) and an `x-rootfast-cache: edge | store | miss` header on
  `/v1` responses.
- **Added** `X-Total-Count` and `Link: <…>; rel="next"` headers on
  `format=csv|ndjson` exports.
- **Changed** responses are now actually cached. The `s-maxage` headers had no
  effect because Cloudflare does not cache a Worker's own output; the Worker
  now stores answers with the Cache API (per Cloudflare location) and keeps
  expensive, day-long-cacheable ones in a global response store. Query
  parameters no endpoint reads are ignored when matching cached answers.
- **Changed** rate limits, per IP per minute: default 120 → 60, search 60 → 30,
  bulk export 5 → 2, plant finder (`POST /v1/plants/search`) 60 → 2. Answers
  served from the edge cache do not count. IPv6 clients are counted per /64.
- **Changed** `format=csv|ndjson` exports return at most 10,000 rows per call
  (was 50,000). **An export that used to arrive whole may now be one page**:
  follow the `Link` header, page with `offset`, or download a dataset release.
- **Changed** `POST` to any route other than `/v1/plants/search` now returns
  405, as documented (it used to run the route's GET handler).
- **Changed** state, county, unfiltered plant and county-count-range listings
  read precomputed summary tables. Response bodies are unchanged;
  `/v1/states/{code}/counties` alone went from about 69,000 rows read per call
  to a few hundred. `/v1/plants/random` no longer scans the catalogue.

### Schema
- **007** `zip_counties` — ZIP → county crosswalk with land share.
- **008** read-cost summaries (`county_plants`, `state_plants`,
  `state_taxa_summary`, `plant_range_summary`, `plant_name_rank`, four count
  columns on `county_taxa_summary`), the operational tables `usage_daily` and
  `response_cache`, and removal of two redundant indexes on
  `plant_county_distribution`. Filled by `api/scripts/populate_summaries.sql`.
- Dataset releases now include the 008 summary tables (they are derived data)
  and exclude the two operational tables from both the Parquet and the SQLite
  artifacts.
- `build_chunks.py` and `build_split_dump.py` take their table order from
  `build.py`; their own copies had gone stale and the reload's wipe step would
  have failed on foreign keys once 007/008 were applied.
- `api/scripts/populate_meta.sql` stamps dataset provenance and counts into
  `schema_meta` for `/healthz`.

### Website
- Home and docs titles now say what this is: a native plant API with
  county-level USDA data. Added schema.org `Dataset` markup.
- Headline numbers on the home, about, and docs pages come from `/healthz` at
  build time, so the pages can no longer disagree with each other.
- Docs: new "Nativity, explained" and "Stability & versions" sections, an
  explicit photo-licensing warning, and corrected statements about rate limits
  and allowed methods.
- About: named maintainer, refresh cadence, and what happens if traffic
  outgrows the free tier.
- "What should I plant here?" accepts a ZIP code.
- Server-rendered pages call the API over a service binding (`web/wrangler.toml`)
  and are cached per Cloudflare location and per deployment, so a repeat view
  no longer re-renders the page or re-queries the database. A cached view is
  still a Function request: this saves CPU and database reads, not requests.
- Plant pages are cached for a day (was seven).
- `robots.txt` asks crawlers to stay off filter / sort / pagination URLs and
  asks SEO-tool and bulk-harvest bots to stay away. It is advisory only.
- Server-rendered pages on `rootfast-web.pages.dev` redirect to `rootfast.org`
  (the prerendered ones are served directly and rely on their canonical tag).
- The about and docs pages no longer claim the service runs inside
  Cloudflare's free tier today; they describe the daily allowance instead.

## 2026-05 — initial public release

- 27,678 taxa, 55 of 56 states and territories, 3,230 counties, 2.5 M
  plant × county nativity records from USDA PLANTS (pulled 2026-05-26).
- USDA PHZM 2023 hardiness zones by ZIP and county; `/v1/hardiness/point`.
- SSURGO soil profile per county; wetland indicators; iNaturalist photos for
  94 % of taxa; GBIF Backbone keys on every plant.
- Schema migrations 001–005.
