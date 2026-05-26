# rootfast Design

## What rootfast is

A single API and a single website. The API answers questions about US plants
by joining several public data sources (USDA PLANTS, USDA Hardiness, and
eventually iNaturalist / GBIF / Wikidata). The website is the human-facing
browser for that API plus its documentation.

This document captures the architectural decisions that make that work.

## Architecture

```
   sources/usda-plants/    Python ETL → SQLite chunk
   sources/usda-hardiness/ Python ETL → SQLite chunk
   sources/<future-src>/   Python ETL → SQLite chunk
                                │
                                ▼
                build/merge step (joins on gbif_taxon_key)
                                │
                                ▼
                        unified SQLite file
                                │
                                ▼
                  wrangler d1 execute --file=…
                                │
                                ▼
                      Cloudflare D1 (managed SQLite)
                                │
                                ▼
                  api/   Cloudflare Worker → REST API
                                │
                                ▼
                  web/   Rootfast website (browser + docs)
```

**One D1, one Worker, one API surface.** The per-source ingestion pipelines
are internal infrastructure — consumers never see them. They exist as
separate folders so each upstream's quirks (auth, scrape pattern, refresh
cadence) stay isolated from the others.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Product shape | One API + one website | Simpler than a federation of per-source APIs; matches the original native-plant-finder vision. |
| Scope | All 50 states, USDA PLANTS first | USDA is the foundation: public domain, county-level distribution, full taxonomy. Other sources enrich on top. |
| Storage | Cloudflare D1 (managed SQLite) | Filter queries are the headline ("drought-tolerant native shrubs in zone 5a"); D1 is the only option that handles them cleanly. |
| Refresh | Manual rebuild | USDA data changes slowly (quarterly at most); no scheduled job needed. |
| ETL language | Python (per source) | Best ecosystem for scraping + pydantic + pandas. Output is a SQLite chunk loaded into D1 by `wrangler`. |
| Type contract | TS Worker types mirror SQL schema | Hand-mirrored for now; generate from a schema-introspection step later. |
| Provenance | Every field carries source + confidence | The Rootfast API exposes "USDA says X / iNaturalist says Y" rather than picking one. The `Sourced<T>` envelope makes this explicit. |

## Scale — what nationwide actually means

USDA's MapServer description states the database covers
> *"over 35,000 plant and lichen species occurring in the United States and its possessions."*

That figure is kingdom-wide and includes lichens, mosses, liverworts, and
some algae. Filtered to the actionable ranks we ingest (Species, Subspecies,
Variety, Form) with a vascular-plant focus, the practical universe is more
like **25,000–30,000 distinct taxa**.

### Measured nationwide totals (probed 2026-05-25)

| Metric | Value | Notes |
|---|---|---|
| Total `(plant × county × nativity)` rows | **3,723,947** | USDA MapServer Layer 6, unfiltered |
| Distinct US counties + territories | ~3,143 | Census standard |
| USDA-stated species count | >35,000 | all kingdoms incl. lichens / mosses / algae |
| Estimated actionable taxa after filter | **~28,000** | Species/Subspecies/Variety/Form, vascular |
| Estimated actionable distribution rows | **~1.75 M** | 3.72 M × ~47 % actionable ratio observed on MT |

### State-by-state distribution sample

| State | Raw distribution rows (MapServer Layer 6) |
|---|---|
| California | 176,895 |
| Florida    | 116,624 |
| Montana    |  68,478 (currently ingested) |
| Wyoming    |  50,732 |

### Projection from current MT slice to nationwide

| Metric | MT (current) | Nationwide projection | Factor |
|---|---|---|---|
| Distinct actionable taxa | 3,215 | ~28,000 | 8.7× |
| Distribution rows after filter | 31,191 | ~1.75 M | 56× |
| D1 storage | 26 MB | ~250 MB | 10× |
| PlantProfile raw cache (local) | 67 MB | ~620 MB | 10× |
| Per-plant tabs raw cache (local) | ~150 MB | ~1.4 GB | 10× |

**Cloudflare free-tier headroom remains comfortable.** D1's 5 GB free tier
caps at ~5 % utilization. Worker request volume is independent of dataset
size.

### Ingest time projection

| Step | MT (actual) | Nationwide (est.) |
|---|---|---|
| County distribution fetch (paginated MapServer) | ~10 min | ~6 h |
| PlantProfile per-taxon cache (16-thread) | ~5 min | ~45 min |
| Per-plant tabs, Has*-gated (16-thread) | ~25 min | ~3 h |
| GBIF taxon match (16-thread) | ~5 min | ~45 min |
| iNat photos (1 req/sec polite cap) | ~40 min | ~8 h |
| Build SQLite + push to D1 | ~2 min | ~15 min |

**Total wall-clock for full nationwide ingest: ~16–18 hours**, almost
entirely unattended. The iNat step dominates because of their 100-req/min
rate ceiling; coordinating with iNat to raise it could cut that to ~3 h.

### Where the long pole is

`characteristicSearchResults` (USDA's species-only endpoint) returns just
**2,186 entries** even nationwide — but it is **not** the master taxon list.
It returns species-rank only and appears further filtered to taxa USDA's
own UI considers primary. The authoritative master taxon set is only
accessible via per-state distribution queries followed by per-taxon
PlantProfile fetches — exactly the pipeline already built for MT.

## Joining strategy — GBIF Backbone

Plants have no universal ID. USDA uses `PIPO`, iNaturalist uses `49217`,
GBIF uses `5285750`, Wikidata uses `Q146283` — all for ponderosa pine.
Scientific names aren't reliable join keys either (Pulsatilla patens ↔
Anemone patens is a different *genus* across sources).

**The Rootfast API uses GBIF Backbone Taxonomy as its canonical taxonomic
key.** Every per-source ingestion pipeline calls GBIF's `/species/match`
once per plant during ingest and records:

| Column | Purpose |
|---|---|
| `gbif_taxon_key` | Primary join key across sources |
| `gbif_canonical_name` | GBIF's authoritative scientific name |
| `gbif_match_type` | `EXACT` / `FUZZY` / `HIGHERRANK` / `NONE` |
| `gbif_match_status` | `ACCEPTED` / `SYNONYM` / `DOUBTFUL` |

Cost: ~35k GBIF calls during a full USDA ingest, ~50ms each, cached
forever. The merge step in the build job joins all source chunks on
`gbif_taxon_key`.

## Risks and open questions

1. **USDA PLANTS county distribution access** — ✅ solved. Two undocumented
   services discovered (PlantsService REST + ArcGIS MapServer). See
   `sources/usda-plants/docs/SOURCES.md`.

2. **USDA hardiness zone access** — ✅ solved. The "downloads page is
   PNG-only" framing is wrong; ArcGIS FeatureServices expose ZIP and
   polygon data.

3. **License hygiene across joined sources** — Xerces is © All Rights
   Reserved. If we later add a non-public-domain source, every joined
   field must carry source so a consumer can filter by license. The
   `Sourced<T>` envelope already supports this.

4. **Schema-version skew between Python (ETL) and TS (Worker)** —
   the SQL schema is the contract. Both sides hand-reference it. First
   refactor target once stabilized: generate TS types from D1
   introspection.

5. **Bloom timing is regionally variable** — a plant blooming in May in
   Virginia may bloom in late June in Montana. Don't try to harmonize
   bloom periods across sources; expose each source's value with its
   provenance and let the consumer interpret.

6. **Hardiness "predominant zone" uses county centroid**, not area-weighted
   majority. Counties spanning multiple zones (Park County spans 3b–5b)
   get one value. Upgrade with shapely polygon intersection in v1.1.

7. **Genus-reclassification synonyms** (e.g. *Anemone patens* ↔ *Pulsatilla
   patens*) aren't tracked in USDA's PlantSynonyms tab. GBIF Backbone
   resolves most of these correctly via its `/species/match` API.

## Path to v1.1+

- iNaturalist research-grade observations as a Layer 1 source
- Wikidata for common names, photos, descriptions
- GBIF occurrence data
- Lat/lng-based hardiness zone via PRISM raster (replaces county-resolution)
- Tallamy host-caterpillar data (NWF Native Plant Finder) — if access path opens
- Versioned dataset releases on GitHub Releases (parquet bulk)
