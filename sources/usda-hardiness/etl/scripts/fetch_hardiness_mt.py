"""Fetch USDA 2023 Plant Hardiness Zone data for Montana.

Two outputs:
1. data/raw/hardiness/mt_county_zones.csv
   One row per MT county: county_id, fips, county_name, predominant_zone,
   zone_desc, centroid_lat, centroid_lon. "Predominant" here is the zone
   at the county centroid, not the area-weighted majority — upgrade path
   noted in docs/SOURCES.md.

2. data/raw/hardiness/mt_zones.geojson
   The 8 MT zone polygons (3a–6b) at the upstream's full resolution.
   Used as the source of truth for arbitrary lat/lng → zone resolution.
   Large (~7.5MB) — Worker bundle uses a simplified version.

Discovered via the public ArcGIS Experience config:
   https://www.arcgis.com/sharing/rest/content/items/b1d1fd9b284e46dcaa43959bec439b44/data

The PHZM_Links_with_zones FeatureService is published by USDA-ARS on ArcGIS
Online at host SyUSN23vOoYdfLC8. Layer 6 (PHZM_Polygon_Links_Join) has
state×zone polygons with `ClassName` (e.g. "5a") and `ClassDesc` (the
temperature range). Joined with state metadata (FIPS, postal abbreviation).
"""

from __future__ import annotations

import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = "rootfast/0.0.1"

COUNTIES_BOUNDARY = (
    "https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/"
    "government_units/plants_boundaries/MapServer/2/query"
)
PHZM = (
    "https://services1.arcgis.com/SyUSN23vOoYdfLC8/arcgis/rest/services/"
    "PHZM_Links_with_zones/FeatureServer/6/query"
)


def _post(url: str, params: dict[str, str], retries: int = 5) -> dict:
    body = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(2 ** attempt)
    assert last is not None
    raise last


def _ring_centroid(rings: list[list[tuple[float, float]]]) -> tuple[float, float]:
    """Mean of all vertices — close enough as a query point. A proper
    area-weighted centroid would need shapely; not worth the dep for v1."""
    xs, ys = [], []
    for ring in rings:
        for pt in ring:
            xs.append(pt[0])
            ys.append(pt[1])
    return sum(xs) / len(xs), sum(ys) / len(ys)


ETL_ROOT = Path(__file__).resolve().parent.parent  # scripts/X.py → etl/
REPO_ROOT = ETL_ROOT.parents[2]


def main() -> None:
    out_dir = ETL_ROOT / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    # We need MT canonical names + IDs to disambiguate from bordering counties
    # that intersect the MT polygon. These come from the USDA Plants ingestion
    # pipeline's cache — cross-source dependency, acceptable for the MT-only run.
    usda_dir = REPO_ROOT / "sources" / "usda-plants" / "etl" / "raw"
    mt_county_file = usda_dir / "mt_counties.json"
    if not mt_county_file.exists():
        sys.exit(
            f"Missing {mt_county_file}. Run sources/usda-plants/etl/scripts/fetch_usda_plants_mt.py first."
        )
    mt_canon = json.loads(mt_county_file.read_bytes())
    mt_names = {c["PlantLocationName"] for c in mt_canon}
    mt_ids = {c["PlantLocationId"] for c in mt_canon}

    mt_poly = json.loads(
        (usda_dir / "mt_polygon.json").read_bytes()
    )["features"][0]["geometry"]

    # 1. MT county polygons (with geometry) — needed for centroids and FIPS.
    print("Fetching MT county polygons...")
    counties_resp = _post(
        COUNTIES_BOUNDARY,
        {
            "where": "1=1",
            "geometry": json.dumps(mt_poly),
            "geometryType": "esriGeometryPolygon",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "plant_location_id,country_subdivision_name,country_subdivision_code",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "json",
        },
    )

    centroids: list[dict] = []
    for feat in counties_resp.get("features", []):
        a = feat.get("attributes", {})
        name = a.get("country_subdivision_name")
        pid = a.get("plant_location_id")
        if name not in mt_names or pid not in mt_ids:
            continue  # bordering counties bleed through Intersects
        geom = feat.get("geometry") or {}
        rings = geom.get("rings") or []
        if not rings:
            continue
        lon, lat = _ring_centroid(rings)
        centroids.append(
            {
                "plant_location_id": pid,
                "county_name": name,
                "fips": a.get("country_subdivision_code"),
                "lon": lon,
                "lat": lat,
            }
        )
    print(f"  {len(centroids)} MT counties with centroids")

    (out_dir / "mt_county_centroids.json").write_text(json.dumps(centroids, indent=2))

    # 2. MT zone polygons (full resolution, for Worker simplification + reference)
    print("Fetching MT zone polygons (GeoJSON)...")
    geojson_req = urllib.request.Request(
        PHZM + "?" + urllib.parse.urlencode(
            {
                "where": "stusps='MT'",
                "outFields": "ClassName,ClassDesc,gridcode,name,stusps",
                "returnGeometry": "true",
                "outSR": "4326",
                "f": "geojson",
            }
        ),
        headers={"User-Agent": UA},
    )
    with urllib.request.urlopen(geojson_req, timeout=60) as r:
        (out_dir / "mt_zones.geojson").write_bytes(r.read())
    print(f"  wrote {(out_dir / 'mt_zones.geojson').stat().st_size / 1024:.1f} KB")

    # 3. Per-county predominant zone via point-in-polygon at the centroid.
    print(f"Querying hardiness zone for each of {len(centroids)} county centroids...")
    rows: list[dict] = []
    for c in centroids:
        pt = {"x": c["lon"], "y": c["lat"], "spatialReference": {"wkid": 4326}}
        resp = _post(
            PHZM,
            {
                "where": "stusps='MT'",
                "geometry": json.dumps(pt),
                "geometryType": "esriGeometryPoint",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
                "outFields": "ClassName,ClassDesc,gridcode",
                "returnGeometry": "false",
                "f": "json",
            },
        )
        feats = resp.get("features", [])
        zone = feats[0]["attributes"].get("ClassName") if feats else None
        desc = feats[0]["attributes"].get("ClassDesc") if feats else None
        rows.append(
            {
                "county_id": c["plant_location_id"],
                "fips": c["fips"],
                "county_name": c["county_name"],
                "predominant_zone": zone,
                "zone_desc": desc,
                "centroid_lat": round(c["lat"], 5),
                "centroid_lon": round(c["lon"], 5),
            }
        )
        time.sleep(0.05)

    out_csv = out_dir / "mt_county_zones.csv"
    with out_csv.open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "county_id",
                "fips",
                "county_name",
                "predominant_zone",
                "zone_desc",
                "centroid_lat",
                "centroid_lon",
            ],
        )
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["county_name"]))

    print(f"Wrote {len(rows)} rows to {out_csv}")
    missing = [r for r in rows if not r["predominant_zone"]]
    if missing:
        print(f"WARNING: {len(missing)} counties with no zone:")
        for r in missing:
            print(f"  {r['county_name']}")


if __name__ == "__main__":
    main()
