# Point-level hardiness — design & upgrade path

`GET /v1/hardiness/point?lat=&lon=` returns the USDA hardiness zone for an
arbitrary coordinate. This doc records where it stands and how to raise its
resolution without breaking the contract.

## Contract (stable)

```json
{
  "query": { "lat": 45.677, "lon": -111.038 },
  "resolution": "county-centroid",
  "note": "...",
  "nearest_county": { "county_fips": "30031", "county_name": "Gallatin", "state_code": "MT",
                      "centroid_lat": 45.44971, "centroid_lon": -111.33832, "approx_distance_mi": 21.3 },
  "zone": { "zone_code": "5a", "zone_class_code": 9, "temp_min_f": -20, "temp_max_f": -15, "description": "5a (-20 to -15 °F)" }
}
```

The `resolution` field is the forward-compatibility hinge. Consumers key off
`zone`; `resolution` tells them how precise the answer is. Upgrades change
`resolution`'s value (and may drop/add the `nearest_county` block) but never the
shape of `zone`.

## Today: county-centroid (shipped)

Ranks county centroids by an equirectangular (cos-scaled) squared distance
computed in SQL — no trig on the D1 side — and returns the nearest county that
has a mapped zone. Uses only data already in D1 (`counties.centroid_*` +
`hardiness_zones_by_county`). Accuracy is poor in large or zone-straddling
counties (Park County, MT spans 3b–5b); a point can sit tens of miles from the
centroid that answers it.

## The real source

The USDA PHZM 2023 is derived from **PRISM 1991–2020** annual-minimum-temperature
normals (~800 m grid). The interactive map is backed by two ArcGIS
FeatureServices (see `sources/usda-plants/docs/SOURCES.md`) exposing the ZIP
table and the zone **polygons** — the same services `sources/usda-hardiness/etl`
already queries.

## Upgrade path

### Step 1 — ZIP-centroid (quick win, ~ZIP resolution)

We already store 40,502 ZIP→zone rows; they just lack coordinates.

- Add a fetch of Census **ZCTA gazetteer** centroids (one public file).
- Schema migration `006`: add `centroid_lat`/`centroid_lon` to
  `hardiness_zones_by_zip`; backfill from the gazetteer.
- Switch the endpoint to nearest **ZIP** centroid (40k points vs 3.2k counties)
  and set `resolution: "zip-centroid"`.

Cheap, no new runtime deps, ~10× denser than counties. Good interim.

### Step 2 — true PRISM resolution

Options, roughly increasing in fidelity and cost:

| Option | Store | Lookup | Notes |
|---|---|---|---|
| **A. Zone polygons** | Simplified PHZM polygons in R2/KV | Point-in-polygon in the Worker (small JS geo routine) | Exact zone boundaries; polygon simplification is the main tuning knob. |
| **B. Quantized grid** | `round(lat,lon → cell) → zone_code` table in D1/KV | Direct key lookup | Simplest runtime; pick a cell size (e.g. 0.01° ≈ 1.1 km) to approach PRISM's ~800 m grid; table is ~10⁷ rows for CONUS. |
| **C. COG raster** | PHZM/PRISM Cloud-Optimized GeoTIFF in R2 | Worker range-reads the tile and samples the pixel | Highest fidelity; needs a GeoTIFF reader in the Worker. |

**Recommendation:** ship Step 1 first (immediate, cheap), then evaluate **B**
(quantized grid) — it keeps the Worker trivial and D1-native, and its accuracy is
tunable by cell size. Reserve **C** for if sub-kilometre precision is ever
required.

Whichever lands, the endpoint sets `resolution` accordingly (`"zip-centroid"` →
`"prism-grid"` / `"prism-raster"`) and consumers keep working unchanged.
