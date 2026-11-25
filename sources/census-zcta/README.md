# sources/census-zcta — ZIP → county crosswalk

Feeds the `zip_counties` table (migration 007), which is what lets
`GET /v1/zip/{zip}/plants` answer "what grows near this ZIP code?".

## Upstream

US Census Bureau, 2020 ZCTA-to-county relationship file (public domain):

```
https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
```

Pipe-delimited, one row per (ZCTA, county) overlap with the land and water
area of the overlap. ~6.8 MB, ~54k rows.

## What a ZCTA is (and isn't)

A ZCTA is the Census Bureau's polygon approximation of a USPS ZIP delivery
area. For almost every residential ZIP the two agree. Differences to know:

- PO-box-only and single-building ZIPs have no ZCTA → those ZIPs 404.
- ZIPs change over time; this is the 2020 vintage, same as the county
  boundaries it references.
- Connecticut: the file uses the eight pre-2022 counties. USDA (and so our
  `counties` table) uses the nine planning regions that replaced them, so
  Connecticut ZIPs are dropped at merge time. Connecticut has no plant
  distribution rows yet either, so nothing is lost today.

## Run

```bash
cd sources/census-zcta/etl
python3 scripts/fetch_zcta_counties.py   # cached under raw/, idempotent
python3 scripts/build_sqlite.py          # → processed/zcta.db
```

`api/scripts/build.py` picks up `processed/zcta.db` automatically and drops
any row whose county isn't in the unified `counties` table.
