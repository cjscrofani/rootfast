# api/schema — Rootfast API database schema

SQL migrations for the Cloudflare D1 database that backs the Rootfast API.
SQLite dialect (D1 is managed SQLite).

## Files

```
schema/
├── 001_initial.sql      All tables, indexes, FTS5, triggers, seed metadata
└── README.md            This file
```

Migrations are numbered and applied via `wrangler d1 migrations apply rootfast`.

## Design at a glance

**14 tables organized into five sections:**

| Section | Tables | Purpose |
|---|---|---|
| 1. Core identity | `plants`, `plant_growth_habits`, `plant_durations`, `plant_common_names` | Plant taxa + multi-valued attributes |
| 2. Geography | `regions`, `states`, `counties`, `plant_native_status`, `plant_county_distribution` | Where each plant occurs + nativity |
| 3. Characteristics | `plant_characteristics` (wide, ~70 columns) | USDA's filterable per-plant attributes |
| 4. Enrichments | `plant_wildlife_value`, `plant_wetland_indicators`, `plant_synonyms`, `plant_status`, `plant_external_references` | Sparser per-plant data |
| 5. Full-text search | `plants_fts` + triggers | Name search |

Plus a `schema_meta` table tracking the applied migration version.

## Key decisions and why

### GBIF Backbone is the cross-source join key

Every row in `plants` carries:
- `gbif_taxon_key`         INTEGER — the universal join key
- `gbif_canonical_name`    TEXT — GBIF's authoritative scientific name
- `gbif_match_type`        EXACT / FUZZY / HIGHERRANK / NONE
- `gbif_match_status`      ACCEPTED / SYNONYM / DOUBTFUL
- `gbif_match_confidence`  0–100

Filled once during ingest via GBIF's `/species/match` endpoint. Lets
future data sources (iNaturalist, Wikidata, GBIF occurrences, etc.) join
into the same plant identity without inheriting USDA-specific quirks.

### Surrogate INTEGER PKs + UNIQUE natural keys

Every entity table uses `INTEGER PRIMARY KEY AUTOINCREMENT` as its surrogate
key, with the natural key (`usda_symbol`, `county_fips`, `state_code`) as a
`UNIQUE` field. Faster joins than text PKs, plays well with future sources
whose native IDs aren't strings, and the natural keys remain queryable.

### Characteristics is wide, not long

USDA tracks ~83 named attributes across four categories. Wide format means
the filter query that motivates the entire project becomes a single SELECT:

```sql
SELECT p.usda_symbol, p.scientific_name
FROM plants p
JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
JOIN plant_growth_habits        pgh ON pgh.plant_id = p.id
JOIN plant_characteristics      pc  ON pc.plant_id = p.id
WHERE pcd.county_fips     = '30031'
  AND pcd.nativity        = 'Native'
  AND pgh.growth_habit    = 'Tree'
  AND pc.drought_tolerance = 'High'
  AND pc.shade_tolerance   IN ('Intermediate','Tolerant');
```

Long format would require either a JOIN per filter (slow) or a pivot.
Wide also matches USDA's source shape, so loading is trivial. NULLs are
cheap in SQLite — ~80% of rows will be all-NULL since USDA only
characterizes ~22% of plants.

### Synonyms and excluded taxa stay as rows in `plants`

If USDA tracks PUPAP2 as `[excluded]` with `AcceptedId=PUPA5`, we store
PUPAP2 as its own row in `plants` with `is_excluded=1` and
`accepted_plant_id` self-foreign-keyed to PUPA5's row. The API
transparently redirects lookups. Preserves USDA's full view; doesn't lie
about what exists.

### Subspecies and varieties self-reference their parent species

`plants.parent_plant_id` lets a variety like *Pinus ponderosa var.
scopulorum* point at its species *Pinus ponderosa*. Useful for the
detail page ("you're looking at a variety — see the parent species").

### Provenance is per-table, not per-cell

Each `CREATE TABLE` comment documents which USDA endpoint or join step
populates it. The API surfaces source attribution at the response-object
level rather than per-field. If a future source contradicts USDA on a
field, we'll add per-field provenance at that point — premature now.

### FTS5 over name fields, kept in sync by triggers

`plants_fts` mirrors `scientific_name`, `scientific_name_canonical`,
`common_name`, `family`, `genus`. INSERT/UPDATE/DELETE triggers keep it
in sync. Used by `GET /search?q=…` and autocomplete.

## Capacity

Estimated nationwide row counts:

| Table | Estimated rows |
|---|---|
| `plants` | ~35,000 |
| `plant_county_distribution` | 1–5 million |
| `plant_characteristics` | ~7,500 (the ~22% with data) |
| `plant_growth_habits` | ~50,000 |
| `plant_external_references` | ~500,000 |
| `plants_fts` | ~35,000 |

D1 hard limit is 10 GB per database. Estimated rootfast size at full
nationwide ingest: **~2 GB**. Comfortable headroom.

## Open questions

1. **`commercial_availability` vocabulary** — saw `'Routinely Available'`,
   `'Contracting Only'`, `'No Known Source'`, `'Field Collections Only'`
   in spot checks. CHECK constraint dropped until full vocab is confirmed
   via nationwide ingest.

2. **`growth_form` vocabulary** — similar. Left as free `TEXT` for now.

3. **`active_growth_period`, `shape_and_orientation`, `flower_color`,
   `foliage_color`, `fruit_color`** — controlled vocabularies USDA may
   not have published. Free `TEXT` for now; tighten to CHECK once the
   nationwide ingest reveals the actual value set.

4. **Provenance per cell** — deliberately deferred. When the second
   source (Wikidata/iNaturalist) lands and contradicts USDA on something,
   add a `field_provenance` table keyed by `(plant_id, field_name)`.

5. **Versioning the dataset itself** — `schema_meta` tracks migration
   version. Need a separate `dataset_version` mechanism that captures
   "this row of data was sourced on date X from upstream version Y." For
   now, `plants.source_version` and `plants.fetched_at` carry that per
   plant — coarse but workable.
