# Data Sources

Status of every upstream dataset we need to join, scoped 2026-05-24 during v1 design.
v1 covers **Montana only**.

## 1. USDA PLANTS — county-level native distribution ✅ SOLVED

- **What we want:** for each Montana county (56 total), the list of plant species
  recorded as present, with native/introduced status.
- **Canonical site:** https://plants.usda.gov (Angular SPA, redirects to plants.sc.egov.usda.gov)
- **The two real APIs (undocumented but stable):**

  1. **PlantsService REST API** at `https://plantsservices.sc.egov.usda.gov/api/` — backs the SPA.
     Endpoint base is discoverable via `https://plants.sc.egov.usda.gov/assets/config.json`.
     Key endpoints we use:
     - `GET /api/StateSearch` — list of all states/provinces with PlantLocationId
     - `GET /api/StateSearch/GetCounties/{plantLocationId}` — counties for a state
     - `GET /api/PlantProfile/{id}` or `?symbol=XXXX` — full species/subspecies/variety record
     - `GET /api/characteristicSearchResults` — 646KB of species-rank-only records (no subspecies/varieties)
     - `GET /api/Plant{Pollinator,Wildlife,Wetland,Characteristics,Documentation,...}/{id}` — per-plant data tabs

  2. **ArcGIS REST MapServer** at
     `https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/land_use_land_cover/plants/MapServer/`
     — backs the per-plant county distribution maps. Has 8 layers; the important ones:
     - Layer 1 (State/Province Boundaries) — has Montana's polygon, keyed by `plant_location_id=3318`
     - Layer 6 (Counties) — **(plant_master_id, county_name, nativity)** rows, queryable

- **Critical gotcha:** Layer 6's `country_subdivision_id` is in a **different ID space**
  than the PlantsService API's PlantLocationId. Filtering layer 6 by county PlantLocationId
  returns garbage (data for completely unrelated counties). Must filter spatially using
  Montana's polygon from layer 1 instead. POST is required because the polygon's
  ~297 vertices blow past GET URL limits.

- **License:** Public domain (federal data).

- **Implementation:** `scripts/fetch_usda_plants_mt.py` (stdlib-only).
  Pulls ~50k Montana presence rows + caches PlantProfile JSON for each distinct
  plant_master_id (~4k taxa) under `data/raw/usda_plants/profiles/`.

- **Validation:** all 56 MT counties covered; ~50k (plant, county, nativity) rows
  after filtering bordering counties (ID/WY/SD/ND/etc) by name match.

### Connecticut data gap (validated 2026-05-26, deferred)

CT abolished its 8 traditional counties on 2022-09-26 and replaced them with
9 Council-of-Governments "planning regions" (Capitol, Greater Bridgeport,
Lower CT River Valley, Naugatuck Valley, Northeastern CT, Northwest Hills,
South Central CT, Southeastern CT, Western CT — FIPS 09110–09190).

USDA's status mid-migration (re-confirmed 2026-05-26):

- **Boundaries layer #2:** the 9 new planning regions are present with
  `plant_location_id` 6705–6715 and the new 5-digit FIPS codes. ✓
- **Distribution layer #6:** zero rows for any of those `plant_location_id`s.
  Old CT-county loc_ids are also gone — they were removed when the new ones
  were added. ✗
- **PlantsService API `PlantProfile`:** `PlantsDistributionResults` returns
  `null` for every plant. `NativeStatuses` only goes to coarse regions
  (CAN, L48, AK, HI) — never state-level. ✗

There is no clever USDA endpoint that returns CT plant×location data
because the data simply doesn't exist on USDA's side right now.

**Decision (v1):** Defer. Re-check quarterly. If/when we need CT before
USDA republishes:

- *Path A — GBIF Occurrences:* query GBIF Occurrence API filtered to
  `stateProvince=Connecticut` and our ~26k existing `gbif_taxon_key`s.
  Aggregates herbaria + iNat + citizen science. Different provenance from
  the USDA gazetteer — must be labelled.
- *Path B — Go Botany / Native Plant Trust:* New England Wildflower Society
  has authoritative CT species lists. Open-source `gobotany-app` repo;
  data-export path unverified.
- *Path C — CT DEEP* lists: state agency lists, less granular than USDA but
  authoritative for legal/conservation status.

Memory note also at `memory/data_source_realities.md`.

## 2. USDA Plant Hardiness Zone Map (2023 update) ✅ SOLVED

- **What we want:** map a lat/lng or county centroid to a hardiness zone (e.g. 4b).
- **Canonical site:** https://planthardiness.ars.usda.gov
- **The downloads page is a red herring** — it only offers PNG/JPG/PDF/EPS/SVG/TIF
  raster images. But the interactive map embeds an ArcGIS Experience Builder app
  whose published data sources include **vector polygon FeatureServices** with the
  zone class joined in.

- **Discovery path:** the embed iframe at https://experience.arcgis.com/experience/b1d1fd9b284e46dcaa43959bec439b44/
  loads its config from
  https://www.arcgis.com/sharing/rest/content/items/b1d1fd9b284e46dcaa43959bec439b44/data?f=json
  which lists all the underlying ArcGIS services.

- **Two usable services:**

  1. **`PHZM_2023_Zip_Code_Table`** — FeatureService at
     `https://services1.arcgis.com/SyUSN23vOoYdfLC8/arcgis/rest/services/PHZM_2023_Zip_Code_Table/FeatureServer/296`.
     40,502 ZIP code rows with fields `ZIP_CODE`, `ZONE_CODE`, `Class` (e.g. `"5a (-20 to -15 °F)"`), `Class_Code` (integer where 1=1a, 2=1b, ..., 9=5a, 10=5b).
     Best path for ZIP-based lookups.

  2. **`PHZM_Links_with_zones`** — FeatureService at
     `https://services1.arcgis.com/SyUSN23vOoYdfLC8/arcgis/rest/services/PHZM_Links_with_zones/FeatureServer/6`.
     371 features nationwide: **state × zone polygons** with `ClassName`, `ClassDesc`, `stusps`. Montana has 8 polygons (3a–6b). Best path for arbitrary lat/lng → zone via point-in-polygon.

- **License:** Public domain (USDA-ARS).

- **Implementation:** `scripts/fetch_hardiness_mt.py`. Pulls MT county polygons
  from the USDA boundaries MapServer, computes centroids, point-in-polygon
  queries `PHZM_Links_with_zones` for each centroid. Outputs:
  - `data/raw/hardiness/mt_county_zones.csv` — the loader-consumed file (56 rows: county_id, fips, county_name, predominant_zone, zone_desc, centroid_lat, centroid_lon)
  - `data/raw/hardiness/mt_zones.geojson` — full-resolution MT zone polygons (~7.5 MB; will need simplification before bundling with the Worker)

- **Bonus finding:** the USDA boundaries MapServer's
  `country_subdivision_code` field is the real 5-digit FIPS code. We now have
  both PlantLocationId and FIPS for every MT county.

- **Caveats:**
  - "Predominant" zone is the zone at the county *centroid*, not area-weighted
    majority. Counties spanning multiple zones (e.g. Park County, which goes
    from the Yellowstone valley to the Beartooth Mountains) get one value;
    area-weighted majority would be better and is a v1.1 upgrade (needs
    polygon intersection via shapely).
  - The 7.5 MB raw GeoJSON is too big to bundle with the Worker. v1.1 needs
    Douglas-Peucker simplification (tolerance ~0.005° ≈ 500m) to get into the
    bundle size budget.

- **Validation:** all 56 MT counties assigned a zone. Distribution:
  3b=7, 4a=25, 4b=14, 5a=6, 5b=1, 6a=3 — matches MT's known climate
  geography (cold northern tier, warm intermountain valleys, warmest in
  the Missoula chinook belt).

## 3. Xerces Society — pollinator-value plant lists

- **What we want:** per-species pollinator value, broken down by group (native
  bees, butterflies, hummingbirds, specialist bees), plus host-plant flags.
- **Canonical site:** https://xerces.org/publications/plant-lists
- **Status:** Cloudflare-protected — automated fetches return 403. Lists are
  published as PDFs.
- **Relevant list for Montana:** "Pollinator Plants: Rocky Mountains Region"
  (https://xerces.org/publications/plant-lists/native-plants-for-pollinators-and-beneficial-insects-rocky-mountains)
  3-page PDF, ~50–100 species, structured tabular layout.
- **License:** Copyright Xerces Society (501(c)(3)). Reuse requires permission
  — **must contact Xerces before publishing the joined dataset**, or store the
  pollinator value field as derived attribution-only data and link out to the
  source PDF.
- **Plan for v1:** download the Rocky Mountains PDF manually, transcribe to a
  YAML file at `data/raw/xerces/rocky_mountains.yaml` keyed by scientific name.
  Small enough to do by hand. Source citation in every field.

## 4. Bloom timing, growing conditions, host plants (Montana-specific)

No single source. We compose this layer from several:

| Source | URL | Covers | Format | License |
|---|---|---|---|---|
| Montana Field Guide (MNHP) | https://fieldguide.mt.gov | distribution, habitat, phenology | Per-species web pages | Public domain (state of MT) |
| MSU Extension "Native Plants for Montana's Home Gardens" | https://extension-store.montana.edu/montguides/native-plants-for-montanas-home-gardens | bloom, zone, drought, pollinator value (broad) | PDF | Public/reuse-friendly |
| Lady Bird Johnson Wildflower Center | https://www.wildflower.org/plants/ | bloom, sun, moisture, soil, mature size, wildlife | Web DB (Cloudflare) | Public domain content per LBJ |
| USDA NRCS Plant Guides / Fact Sheets | https://plants.usda.gov | per-species PDFs with cultivation data | PDF per species | Public domain |
| NWF Native Plant Finder (Tallamy host data) | https://nativeplantfinder.nwf.org | host caterpillar counts by ZIP | Web tool (Cloudflare) | Research data; check reuse terms |

**Plan for v1:**
- Use Montana Field Guide as the per-species enrichment source — scrape one
  page per species, parse out distribution and habitat sections.
- Use MSU Extension PDF as the human-curated "starter set" of ~100 well-known
  Montana natives with cultivation notes.
- Use NRCS Plant Guides for plants where we need more detail.
- Tallamy host data is the highest-value enrichment but the access path is
  least clear. Defer to v1.1 unless we find a clean source.

### Montana Field Guide ✅ INGESTED

- **fieldguide.mt.gov** is server-side rendered ASP.NET WebForms. No JSON
  API, no AJAX — the data is right there in the HTML. Navigation tree:
  `displayPhyDiv` → `displayClasses` → `displayFamily` → `displaySpecies` →
  `speciesDetail.aspx?elcode={ELCODE}`.
- **Per-species page sections** (parsed by `scripts/consolidate_field_guide.py`):
  - `#gen` — general botanical description (always populated, ~500 chars)
  - `#habt` — habitat narrative (79% populated)
  - `#dist` — distribution header (very short, just "Native"/"Introduced")
  - `#cit` — literature citations (parsed as list)
  - `var dataStatewideModelOwners` — JSON with range stats (acres, % of MT)
    by land ownership (Federal/State/Tribal/Private)
- **`ObsChart_FS.aspx?elcode=ELCODE`** returns a tiny HTML page with a
  per-month observation count table. **Powerful free phenology proxy** —
  the peak observation month correlates with bloom (for showy forbs) or
  leaf-out (for trees). Used as a LOW-confidence bloom estimator when no
  better source exists.
- **3,834 plant ELCODEs total** across 12 phyla (PD=2210 dicots, PM=645
  monocots, PG=20 conifers, PP=88 ferns, plus mosses/algae).
- **USDA crosswalk by binomial + synonym table:** 2,591 of 3,834 records (67.6%)
  overall, **87.4% for vascular plants** (PD+PM+PG+PP). Match path:
  1. Direct binomial match against USDA's MT accepted-name set
  2. Synonym fallback via the cached PlantSynonyms tabs
  3. Subordinate-taxa fallback via the cached PlantSubordinateTaxa tabs
  Non-vascular plants (NA algae, NB mosses) contribute the bulk of the residual
  miss — USDA doesn't track them densely. The genuine vascular-plant gap is
  mostly Field Guide records whose taxa don't have an MT county distribution
  record in USDA at all (e.g., *Asclepias incarnata*), not naming mismatches.
- **License:** Public domain — Montana state agency publication
  (MT Natural Heritage Program). Attribution courtesy.
- **Files produced:**
  - `data/raw/field_guide/elcodes.json` — discovered ELCODE list
  - `data/raw/field_guide/species/{ELCODE}.html` (3,834 files, ~150 MB)
  - `data/raw/field_guide/obs_chart/{ELCODE}.html` (3,834 files, ~14 MB)
  - `data/raw/field_guide/mt_field_guide_full.json` — consolidated (14.7 MB)

## Field coverage matrix (v1 target)

| Field | Best source | v1 confidence |
|---|---|---|
| County native presence | USDA PLANTS / BONAP / BIEN | high |
| Hardiness zone fit | Hand-built MT county→zone CSV | medium |
| Bloom start/peak/end | MSU + Field Guide + NRCS | low–medium |
| Bloom color | MSU + Field Guide | medium |
| Mature size | MSU + LBJ | medium |
| Sun preference | MSU + LBJ + NRCS | medium |
| Moisture preference | MSU + LBJ + NRCS | medium |
| Soil tolerances | NRCS | low–medium |
| Pollinator value | Xerces Rocky Mountains (pending license) | medium |
| Bird value | Field Guide + LBJ | low |
| Host caterpillars | NWF Native Plant Finder | **deferred to v1.1** |
| Commercial availability | MT Native Plant Society + manual | low |
| Caveats (toxic / aggressive / browse) | NRCS + Field Guide | medium |

Every field in the published dataset will carry `{ value, source, confidence }`
so downstream consumers can filter by confidence.
