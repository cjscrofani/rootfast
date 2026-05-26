"""Fetch Montana plant × county × nativity records from USDA PLANTS.

Source: ArcGIS REST endpoint backing plants.usda.gov's distribution maps.
Layers used (all under land_use_land_cover/plants/MapServer):
    1  State/Province Boundaries  — used to get Montana's polygon
    6  Counties                   — (plant_master_id, county, nativity) rows

The Counties layer's `country_subdivision_id` does NOT match the PlantsService
API's PlantLocationId for counties — different ID spaces. So we filter by
geometry instead: query layer 1 for Montana's polygon, then pass that polygon
as the spatial filter on layer 6.

The Symbol field in layer 6 is misnamed — it holds the nativity status string
("Native", "Introduced", "Both"). The USDA plant symbol is resolved later
from the API's master plant list.

Outputs:
    data/raw/usda_plants/mt_polygon.json         — MT state polygon (WGS84)
    data/raw/usda_plants/mt_counties.json        — 56 MT counties + PlantLocationIds
    data/raw/usda_plants/mt_distribution.json    — all (plant,county,nativity) rows
    data/raw/usda_plants/master_plant_list.json  — species master list (limited)

Pure stdlib so it runs without `pip install`. Re-run any time to refresh.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://plantsservices.sc.egov.usda.gov/api"
GIS_BASE = "https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/land_use_land_cover/plants/MapServer"
GIS_STATES = f"{GIS_BASE}/1"
GIS_COUNTIES = f"{GIS_BASE}/6"
MT_PLANT_LOCATION_ID = 3318
PAGE_SIZE = 2000
UA = "rootfast/0.0.1 (https://github.com/...; data ingest)"


def _open(url: str, data: bytes | None = None, retries: int = 5) -> bytes:
    headers = {"User-Agent": UA}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last_err = e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
        wait = 2**attempt
        print(f"  transient error {last_err}; retrying in {wait}s", file=sys.stderr)
        time.sleep(wait)
    assert last_err is not None
    raise last_err


def get(url: str, retries: int = 5) -> bytes:
    return _open(url, None, retries)


def post(url: str, params: dict[str, str], retries: int = 5) -> bytes:
    body = urllib.parse.urlencode(params).encode()
    return _open(url, body, retries)


ETL_ROOT = Path(__file__).resolve().parent.parent  # scripts/X.py → etl/


def main() -> None:
    out_dir = ETL_ROOT / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Montana counties + their PlantLocationIds.
    print("Fetching Montana counties...")
    counties_raw = get(f"{API}/StateSearch/GetCounties/{MT_PLANT_LOCATION_ID}")
    counties = json.loads(counties_raw)
    (out_dir / "mt_counties.json").write_bytes(counties_raw)
    county_ids = [c["PlantLocationId"] for c in counties]
    print(f"  {len(county_ids)} counties")

    # 2. Master plant list. Used later to resolve plant_master_id → symbol/name.
    print("Fetching master plant list...")
    master_raw = get(f"{API}/characteristicSearchResults")
    master = json.loads(master_raw)
    (out_dir / "master_plant_list.json").write_bytes(master_raw)
    print(f"  {len(master)} taxa")

    # 3. Get Montana's polygon to use as a spatial filter on the counties layer.
    print("Fetching Montana polygon...")
    poly_url = (
        f"{GIS_STATES}/query?where=plant_location_id%3D{MT_PLANT_LOCATION_ID}"
        f"&outFields=plant_location_id&returnGeometry=true&outSR=4326&f=json"
    )
    poly_raw = get(poly_url)
    (out_dir / "mt_polygon.json").write_bytes(poly_raw)
    mt_geom = json.loads(poly_raw)["features"][0]["geometry"]
    print(f"  polygon ring with {len(mt_geom['rings'][0])} vertices")

    # 4. Paginated query of MapServer/6 spatially filtered to Montana.
    # ArcGIS REST accepts POST when the geometry blows past GET URL limits.
    common = {
        "where": "1=1",
        "geometry": json.dumps(mt_geom),
        "geometryType": "esriGeometryPolygon",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "false",
        "f": "json",
    }
    total = json.loads(
        post(f"{GIS_COUNTIES}/query", {**common, "returnCountOnly": "true"})
    )["count"]
    print(f"Fetching {total} distribution rows in pages of {PAGE_SIZE}...")

    rows: list[dict] = []
    offset = 0
    while offset < total:
        page = json.loads(
            post(
                f"{GIS_COUNTIES}/query",
                {
                    **common,
                    "orderByFields": "ESRI_OID",
                    "resultOffset": str(offset),
                    "resultRecordCount": str(PAGE_SIZE),
                },
            )
        )
        features = page.get("features", [])
        if not features:
            print(f"  page at offset {offset}: empty, stopping", file=sys.stderr)
            break
        rows.extend(f["attributes"] for f in features)
        offset += len(features)
        print(f"  fetched {offset}/{total}")
        time.sleep(0.1)  # politeness

    (out_dir / "mt_distribution.json").write_text(json.dumps(rows))
    print(f"Wrote {len(rows)} rows to data/raw/usda_plants/mt_distribution.json")

    # 5. For every distinct plant_master_id seen in MT, fetch its PlantProfile.
    # characteristicSearchResults only carries species-rank entries; the MT
    # distribution includes subspecies and varieties too, so we have to
    # backfill the rest via PlantProfile/{id}. Done in parallel — the
    # PlantsService is happy to serve ~16 concurrent requests.
    from concurrent.futures import ThreadPoolExecutor, as_completed

    profile_dir = out_dir / "profiles"
    profile_dir.mkdir(exist_ok=True)

    mt_county_names = {c["PlantLocationName"] for c in counties}
    plant_ids = sorted({r["plant_master_id"] for r in rows if r["country_subdivision_name"] in mt_county_names})

    need: list[int] = []
    cached = 0
    for pid in plant_ids:
        path = profile_dir / f"{pid}.json"
        if path.exists() and path.stat().st_size > 100:
            cached += 1
        else:
            need.append(pid)

    print(f"Caching {len(plant_ids)} PlantProfiles ({cached} already on disk, fetching {len(need)})...")

    def _fetch_one(pid: int) -> tuple[int, bool]:
        try:
            body = get(f"{API}/PlantProfile/{pid}")
            (profile_dir / f"{pid}.json").write_bytes(body)
            return pid, True
        except Exception as e:
            print(f"  {pid}: {e}", file=sys.stderr)
            return pid, False

    fetched_ok = 0
    fetched_total = 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        for pid, ok in (f.result() for f in as_completed([ex.submit(_fetch_one, p) for p in need])):
            fetched_total += 1
            if ok:
                fetched_ok += 1
            if fetched_total % 200 == 0:
                print(f"  {fetched_total}/{len(need)} fetched ({fetched_ok} ok)")

    print(f"PlantProfile cache: {cached + fetched_ok}/{len(plant_ids)} total "
          f"({cached} reused, {fetched_ok} fetched, {fetched_total - fetched_ok} failed)")


if __name__ == "__main__":
    main()
