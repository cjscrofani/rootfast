# experimental/montana/

**Sidelined work** from the original rootfast Montana vertical slice.

Kept intact for future revival. None of this is part of v1. Each subfolder
could become a future Rootfast API data source once the single-API foundation
is in place.

## What's here

```
experimental/montana/
├── field_guide/             MT Natural Heritage Program scraper + cache
│   ├── scripts/
│   │   ├── fetch_field_guide_mt.py      Crawls fieldguide.mt.gov (3,834 species)
│   │   └── consolidate_field_guide.py   HTML → JSON, USDA crosswalk
│   ├── mt_field_guide.py    Loader (was data/src/rootfast/sources/)
│   └── raw/                 Scraped HTML cache + consolidated JSON
├── sidelined_sources/       Loader stubs for Xerces + MSU Extension
│   ├── xerces.py            (license-blocked — see SOURCES.md)
│   └── msu_extension.py     (deprioritized — USDA Characteristics covers most)
├── xerces/                  Reserved for Xerces PDFs once permission lands
└── docs/                    MT-specific notes (currently empty; SOURCES moved to sources/usda-plants/docs/)
```

## Why each piece was sidelined

| Source | Reason sidelined |
|---|---|
| **MT Field Guide** | Single-state scope. Each US state has its own natural-heritage program with a different access pattern — no national equivalent. A great future data source for the Rootfast API but not v1. |
| **Xerces** | All-rights-reserved license. Permission request backlogged. |
| **MSU Extension** | MT-only PDF guide. Mostly redundant with USDA Characteristics for the well-documented plants. |

## What's worth knowing if you revive this

- `field_guide/scripts/` script paths reference cross-source data via old
  `data/raw/...` paths — will need updating (point at the new
  `sources/usda-plants/etl/raw/` location for USDA crosswalk inputs).
- The consolidated MT Field Guide JSON (~15 MB) at
  `field_guide/raw/mt_field_guide_full.json` is a complete artifact and
  usable as-is.
- Discovered access patterns + gotchas live in this repo's git history and
  the consolidated `sources/usda-plants/docs/SOURCES.md`.
