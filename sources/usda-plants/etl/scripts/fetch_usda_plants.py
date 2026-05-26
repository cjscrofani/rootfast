"""Fetch USDA PLANTS distribution + per-taxon profiles for ONE state.

Uses the same approach that worked for Montana: spatial-filter the MapServer
Counties layer (#6) by the state's polygon, paginate, then fetch a PlantProfile
for every distinct plant_master_id we saw.

Invoke per state:
    fetch_usda_plants.py MT
    fetch_usda_plants.py RI

Outputs (per state):
    raw/distribution_per_state/{XX}.json     all (plant, county, nativity) rows
    raw/profiles/{id}.json                   shared PlantProfile cache

After every state's chunk is written, run consolidate_usda_plants.py to merge
chunks into raw/distribution.json (a separate, idempotent step).
"""

from __future__ import annotations

import http.client
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

API = "https://plantsservices.sc.egov.usda.gov/api"
GIS_COUNTIES = (
    "https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/"
    "land_use_land_cover/plants/MapServer/6/query"
)

PAGE_SIZE = 2000
PROFILE_WORKERS = 16
INTER_PAGE_SLEEP = 1.0     # politeness — proven MT pattern used 0.1s, we use 1s to be safer
SOFT_RETRY_BACKOFF = [10, 20, 40, 60]

UA = "rootfast/0.1 (https://rootfast.org; cj@gdws.co)"

ETL_ROOT = Path(__file__).resolve().parent.parent
RAW = ETL_ROOT / "raw"
PROFILE_DIR = RAW / "profiles"
STATE_DIR = RAW / "distribution_per_state"
STATE_POLYGONS = RAW / "state_polygons.json"
COUNTIES_JSON = RAW / "counties.json"


# ---- HTTP helpers --------------------------------------------------------

def _open(url: str, data: bytes | None = None, retries: int = 8, timeout: int = 90) -> bytes:
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError,
                socket.timeout, http.client.HTTPException, OSError) as e:
            last = e
        wait = min(60, 2 ** attempt)
        time.sleep(wait)
    assert last is not None
    raise last


def post(url: str, params: dict[str, str]) -> bytes:
    body = urllib.parse.urlencode(params).encode()
    return _open(url, body)


# ---- Distribution fetch — spatial filter --------------------------------

def fetch_state(state_code: str) -> list[dict]:
    """Spatial-filter MapServer layer 6 by the state's polygon and paginate.

    Idempotent: skips if the checkpoint file exists.
    """
    chunk_path = STATE_DIR / f"{state_code}.json"
    if chunk_path.exists() and chunk_path.stat().st_size > 2:
        rows = json.loads(chunk_path.read_bytes())
        print(f"{state_code}: cached ({len(rows):,} rows) — delete file to re-fetch", flush=True)
        return rows

    polygons = json.loads(STATE_POLYGONS.read_bytes())
    if state_code not in polygons:
        raise SystemExit(f"No polygon for state {state_code} in state_polygons.json")
    polygon = polygons[state_code]

    common = {
        "where": "1=1",
        "geometry": json.dumps(polygon),
        "geometryType": "esriGeometryPolygon",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "false",
        "f": "json",
    }

    # Get total count for the state up front.
    body = post(GIS_COUNTIES, {**common, "returnCountOnly": "true"})
    head = json.loads(body)
    if "error" in head:
        raise SystemExit(f"{state_code}: count query failed: {head['error']}")
    total = head.get("count", 0)
    print(f"{state_code}: {total:,} distribution rows (paging {PAGE_SIZE} at a time)",
          flush=True)

    rows: list[dict] = []
    offset = 0
    pages = 0
    started = time.time()
    while offset < total:
        page = _fetch_page(common, offset)
        feats = page.get("features", [])
        if not feats:
            print(f"  page at offset {offset}: empty, stopping", file=sys.stderr, flush=True)
            break
        rows.extend(f["attributes"] for f in feats)
        offset += len(feats)
        pages += 1
        if pages % 5 == 0 or offset >= total:
            elapsed = time.time() - started
            print(f"  {offset:,}/{total:,} ({elapsed:.1f}s elapsed)", flush=True)
        time.sleep(INTER_PAGE_SLEEP)

    chunk_path.write_text(json.dumps(rows))
    elapsed = time.time() - started
    print(f"{state_code}: wrote {len(rows):,} rows to {chunk_path.name} ({elapsed:.1f}s)",
          flush=True)
    return rows


def _fetch_page(common: dict[str, str], offset: int) -> dict:
    """Single page with soft-retry on ArcGIS errors."""
    page: dict = {}
    for attempt, backoff in enumerate([0] + SOFT_RETRY_BACKOFF):
        if backoff:
            time.sleep(backoff)
        body = post(GIS_COUNTIES, {
            **common,
            "orderByFields": "ESRI_OID",
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE_SIZE),
        })
        page = json.loads(body)
        if "error" not in page:
            return page
        print(f"    soft retry {attempt + 1}/{len(SOFT_RETRY_BACKOFF) + 1} "
              f"(offset={offset}, error={page['error']})", file=sys.stderr, flush=True)
    raise SystemExit(f"giving up at offset {offset}: {page.get('error')}")


# ---- Profile fetch -------------------------------------------------------

def fetch_profiles_for(plant_master_ids: list[int]) -> tuple[int, int]:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    need: list[int] = []
    cached = 0
    for pid in plant_master_ids:
        p = PROFILE_DIR / f"{pid}.json"
        if p.exists() and p.stat().st_size > 100:
            cached += 1
        else:
            need.append(pid)
    print(f"PlantProfile cache: {cached} already on disk, fetching {len(need)} new", flush=True)
    if not need:
        return cached, 0

    def _fetch(pid: int) -> tuple[int, bool, str | None]:
        try:
            body = _open(f"{API}/PlantProfile/{pid}")
            (PROFILE_DIR / f"{pid}.json").write_bytes(body)
            return pid, True, None
        except Exception as e:
            return pid, False, str(e)

    ok = 0
    failed = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=PROFILE_WORKERS) as ex:
        for pid, succeeded, err in (
            f.result() for f in as_completed([ex.submit(_fetch, p) for p in need])
        ):
            if succeeded:
                ok += 1
            else:
                failed += 1
                if failed < 5:
                    print(f"  {pid}: {err}", file=sys.stderr, flush=True)
            n = ok + failed
            if n % 500 == 0:
                elapsed = time.time() - started
                rate = n / max(elapsed, 0.1)
                eta = (len(need) - n) / max(rate, 0.001) / 60
                print(f"  {n}/{len(need)} fetched ({ok} ok, {failed} fail · ~{eta:.1f}m left)",
                      flush=True)
    print(f"PlantProfile fetch: {ok} ok, {failed} failed", flush=True)
    return cached, ok


# ---- main ---------------------------------------------------------------

def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} STATE_CODE   (e.g. RI, MT, CA)")
    state_code = sys.argv[1].upper()

    RAW.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[1/2] Distribution for {state_code} → {STATE_DIR.name}/{state_code}.json",
          flush=True)
    rows = fetch_state(state_code)

    # Filter rows to the state's actual county names (the polygon catches a
    # narrow strip beyond the border, so neighboring-state counties can
    # appear). Use counties.json as the authoritative state membership list.
    counties = json.loads(COUNTIES_JSON.read_bytes())
    state_county_names = {
        c["county_name"] for c in counties if c["state_code"] == state_code
    }
    in_state = [r for r in rows if r.get("country_subdivision_name") in state_county_names]
    print(f"  {len(in_state):,} rows match {state_code} counties "
          f"(filtered {len(rows) - len(in_state):,} border spill)", flush=True)

    print(f"\n[2/2] PlantProfiles for plant_master_ids seen in {state_code}", flush=True)
    pids = sorted({r["plant_master_id"] for r in in_state if r.get("plant_master_id")})
    print(f"  distinct plant_master_ids: {len(pids):,}", flush=True)
    fetch_profiles_for(pids)


if __name__ == "__main__":
    main()
