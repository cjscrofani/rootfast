"""Fetch USDA 2023 Plant Hardiness Zone data nationwide.

Three outputs under sources/usda-hardiness/etl/raw/:

  zip_zones.csv               One row per US ZIP → zone (~40,502 rows).
                              Pulled in one shot from the PHZM ZIP table.

  zones/{state}.geojson       Per-state PHZM polygons, full resolution.
                              Stored as raw GeoJSON files (one per state)
                              so the Worker can later ship simplified
                              versions for browser-side maps or PIP.

  county_zones.csv            Per-county predominant zone, derived by
                              sampling each county's centroid against
                              the polygon service.

Re-runnable: each step writes idempotently. Pass --state XX to limit the
polygon + centroid PIP work to one state (the ZIP table is always full).

Discovery: see sources/usda-hardiness/README.md.
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = "rootfast/0.1.0"

# USDA-ARS PHZM 2023 ArcGIS services
PHZM_ZIP_TABLE = (
    "https://services1.arcgis.com/SyUSN23vOoYdfLC8/arcgis/rest/services/"
    "PHZM_2023_Zip_Code_Table/FeatureServer/296/query"
)
PHZM_POLY = (
    "https://services1.arcgis.com/SyUSN23vOoYdfLC8/arcgis/rest/services/"
    "PHZM_Links_with_zones/FeatureServer/6/query"
)
# USDA NRCS county boundaries — the canonical 5-digit FIPS + centroid source.
COUNTIES_BOUNDARY = (
    "https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/"
    "government_units/plants_boundaries/MapServer/2/query"
)

ETL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]
RAW = ETL_ROOT / "raw"
USDA_PLANTS_DB = REPO_ROOT / "sources" / "usda-plants" / "etl" / "processed" / "usda_plants.db"


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


def _get_bytes(url: str, params: dict[str, str], retries: int = 5) -> bytes:
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": UA})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(2 ** attempt)
    assert last is not None
    raise last


# ---------------------------------------------------------------------------
# 1. ZIP → zone
# ---------------------------------------------------------------------------

def fetch_zip_table(out_path: Path) -> int:
    """Pull every ZIP from PHZM_2023_Zip_Code_Table. Paged 2000/page."""
    if out_path.exists() and out_path.stat().st_size > 0:
        print(f"  zip_zones.csv already present at {out_path} — skipping")
        with out_path.open() as f:
            return sum(1 for _ in f) - 1
    rows: list[dict] = []
    offset = 0
    page = 2000
    while True:
        resp = _post(
            PHZM_ZIP_TABLE,
            {
                "where": "1=1",
                "outFields": "ZIP_CODE,ZONE_CODE,Class,Class_Code",
                "returnGeometry": "false",
                "resultOffset": str(offset),
                "resultRecordCount": str(page),
                "orderByFields": "ZIP_CODE",
                "f": "json",
            },
        )
        feats = resp.get("features", [])
        if not feats:
            break
        for f in feats:
            a = f.get("attributes", {})
            rows.append({
                "zip_code": str(a.get("ZIP_CODE") or "").strip(),
                "zone_code": str(a.get("ZONE_CODE") or "").strip(),
                "zone_class": str(a.get("Class") or "").strip(),
                "zone_class_code": a.get("Class_Code"),
            })
        offset += len(feats)
        print(f"  ZIP table: {offset} rows fetched")
        if len(feats) < page:
            break

    # Deduplicate by ZIP (the upstream sometimes has multi-row joins)
    seen: dict[str, dict] = {}
    for r in rows:
        if r["zip_code"] and r["zip_code"] not in seen:
            seen[r["zip_code"]] = r

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(
            f, fieldnames=["zip_code", "zone_code", "zone_class", "zone_class_code"]
        )
        w.writeheader()
        for r in sorted(seen.values(), key=lambda x: x["zip_code"]):
            w.writerow(r)
    print(f"  wrote {len(seen)} ZIPs → {out_path}")
    return len(seen)


# ---------------------------------------------------------------------------
# 2. Per-state zone polygons (full resolution GeoJSON)
# ---------------------------------------------------------------------------

def fetch_state_polygons(state: str, out_path: Path, force: bool = False) -> bool:
    if out_path.exists() and not force and out_path.stat().st_size > 0:
        print(f"  zones/{state}.geojson already present — skipping")
        return False
    data = _get_bytes(
        PHZM_POLY,
        {
            "where": f"stusps='{state}'",
            "outFields": "ClassName,ClassDesc,gridcode,name,stusps",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        },
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    print(f"  {state}: wrote {len(data) / 1024:.1f} KB → zones/{state}.geojson")
    return True


# ---------------------------------------------------------------------------
# 3. Per-county centroid → predominant zone
# ---------------------------------------------------------------------------

def fetch_county_centroids(state: str) -> list[dict]:
    """Read county centroids straight from the USDA Plants SQLite chunk.

    That chunk already fetched + filtered counties per state during the
    nationwide expansion, so we avoid a fragile re-query against the USDA
    boundaries service (which uses ill-documented attribute fields)."""
    if not USDA_PLANTS_DB.exists():
        raise SystemExit(
            f"Missing {USDA_PLANTS_DB}. Run sources/usda-plants/etl/scripts/build_sqlite.py first."
        )
    db = sqlite3.connect(USDA_PLANTS_DB)
    try:
        cur = db.execute(
            """SELECT county_fips, county_name, usda_plant_location_id,
                      centroid_lat, centroid_lon
                 FROM counties
                WHERE state_code = ?
                  AND centroid_lat IS NOT NULL
                  AND centroid_lon IS NOT NULL
             ORDER BY county_fips""",
            (state,),
        )
        return [
            {
                "fips": r[0],
                "county_name": r[1],
                "state": state,
                "plant_location_id": r[2],
                "lat": r[3],
                "lon": r[4],
            }
            for r in cur.fetchall()
        ]
    finally:
        db.close()


def lookup_zone_for_point(lon: float, lat: float, state: str) -> tuple[str | None, str | None]:
    """Server-side PIP against the PHZM polygon layer. Returns (zone_code, desc)."""
    pt = {"x": lon, "y": lat, "spatialReference": {"wkid": 4326}}
    resp = _post(
        PHZM_POLY,
        {
            "where": f"stusps='{state}'",
            "geometry": json.dumps(pt),
            "geometryType": "esriGeometryPoint",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "ClassName,ClassDesc",
            "returnGeometry": "false",
            "f": "json",
        },
    )
    feats = resp.get("features", [])
    if not feats:
        return None, None
    a = feats[0]["attributes"]
    return a.get("ClassName"), a.get("ClassDesc")


# USPS state codes USDA's PHZM covers
US_STATES = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
    "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
    "DC","PR","VI","GU","AS","MP",
]

_STATE_NAMES = {
    "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California",
    "CO":"Colorado","CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia",
    "HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa",
    "KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland",
    "MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri",
    "MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey",
    "NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio",
    "OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina",
    "SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont",
    "VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming",
    "DC":"District of Columbia","PR":"Puerto Rico","VI":"U.S. Virgin Islands",
    "GU":"Guam","AS":"American Samoa","MP":"Northern Mariana Islands",
}


def _state_name(state: str) -> str:
    return _STATE_NAMES.get(state, state)


def fetch_county_zones(states: list[str], out_path: Path) -> int:
    """For each state, fetch county polygons + centroid PIP each into a zone."""
    existing: dict[str, dict] = {}
    if out_path.exists():
        with out_path.open() as f:
            for row in csv.DictReader(f):
                existing[row["fips"]] = row
        print(f"  county_zones.csv has {len(existing)} existing rows")

    new_rows: list[dict] = []
    for state in states:
        print(f"  {state}: fetching counties…")
        try:
            centroids = fetch_county_centroids(state)
        except Exception as e:
            print(f"  {state}: ERROR fetching counties: {e!r} — skipping")
            continue
        print(f"  {state}: {len(centroids)} counties → centroid PIP")
        for c in centroids:
            if not c["fips"]:
                continue
            if c["fips"] in existing:
                continue
            zone, desc = lookup_zone_for_point(c["lon"], c["lat"], state)
            new_rows.append({
                "fips": c["fips"],
                "county_name": c["county_name"],
                "state": state,
                "plant_location_id": c["plant_location_id"] or "",
                "centroid_lat": round(c["lat"], 5),
                "centroid_lon": round(c["lon"], 5),
                "zone_code": zone or "",
                "zone_class": desc or "",
            })
            time.sleep(0.05)
        # Persist progress after each state so a crash mid-run doesn't lose work.
        all_rows = list(existing.values()) + new_rows
        all_rows.sort(key=lambda r: r["fips"])
        with out_path.open("w", newline="") as f:
            w = csv.DictWriter(
                f,
                fieldnames=[
                    "fips","county_name","state","plant_location_id",
                    "centroid_lat","centroid_lon","zone_code","zone_class",
                ],
            )
            w.writeheader()
            w.writerows(all_rows)
        print(f"  {state}: total county_zones rows = {len(all_rows)}")
    return len(existing) + len(new_rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", help="USPS code; default = all states. ZIP table is always full.")
    ap.add_argument("--skip-zip",      action="store_true", help="Skip ZIP table fetch")
    ap.add_argument("--skip-polygons", action="store_true", help="Skip polygon download")
    ap.add_argument("--skip-county",   action="store_true", help="Skip county centroid PIP")
    args = ap.parse_args()

    states = [args.state] if args.state else US_STATES
    RAW.mkdir(parents=True, exist_ok=True)

    if not args.skip_zip:
        print("[1/3] ZIP → zone (nationwide)")
        fetch_zip_table(RAW / "zip_zones.csv")

    if not args.skip_polygons:
        print(f"[2/3] State zone polygons ({len(states)} state(s))")
        for s in states:
            try:
                fetch_state_polygons(s, RAW / "zones" / f"{s}.geojson")
            except urllib.error.HTTPError as e:
                # Some territories (e.g. AS, MP) may not have PHZM polygons.
                print(f"  {s}: polygon fetch failed ({e}); skipping")

    if not args.skip_county:
        print(f"[3/3] County centroid → predominant zone ({len(states)} state(s))")
        fetch_county_zones(states, RAW / "county_zones.csv")


if __name__ == "__main__":
    main()
