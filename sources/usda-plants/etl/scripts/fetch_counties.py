"""Pull all US states + counties from USDA's boundaries MapServer.

Source:
    https://apps.geo.fpac.usda.gov/.../government_units/plants_boundaries/MapServer
        Layer 1 = State/Province Boundaries (with USDA plant_location_id)
        Layer 2 = County Boundaries          (with country_subdivision_code = FIPS)

Outputs:
    raw/states.json     [{state_code, state_name, state_fips, country,
                          usda_plant_location_id}, ...] for US states + DC + territories
    raw/counties.json   [{county_fips, county_name, state_code,
                          usda_plant_location_id, centroid_lat, centroid_lon}, ...]

We bypass the sister hardiness-API dependency. The data here covers all 50
US states + DC + territories. Canada / Greenland / etc. are omitted from v1.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = "rootfast/0.1 (https://rootfast.org; cj@gdws.co)"
COUNTIES = (
    "https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/"
    "government_units/plants_boundaries/MapServer/2/query"
)
STATES = (
    "https://apps.geo.fpac.usda.gov/nrcs-geodata/rest/services/"
    "government_units/plants_boundaries/MapServer/1/query"
)

ETL_ROOT = Path(__file__).resolve().parent.parent
RAW = ETL_ROOT / "raw"

# US state + territory two-letter codes (with FIPS state codes).
# USDA tracks Canadian provinces too but we omit them from v1.
US_STATES: dict[str, tuple[str, str]] = {
    # state_fips: (state_code, state_name)
    "01": ("AL", "Alabama"),         "02": ("AK", "Alaska"),
    "04": ("AZ", "Arizona"),         "05": ("AR", "Arkansas"),
    "06": ("CA", "California"),      "08": ("CO", "Colorado"),
    "09": ("CT", "Connecticut"),     "10": ("DE", "Delaware"),
    "11": ("DC", "District of Columbia"),
    "12": ("FL", "Florida"),         "13": ("GA", "Georgia"),
    "15": ("HI", "Hawaii"),          "16": ("ID", "Idaho"),
    "17": ("IL", "Illinois"),        "18": ("IN", "Indiana"),
    "19": ("IA", "Iowa"),            "20": ("KS", "Kansas"),
    "21": ("KY", "Kentucky"),        "22": ("LA", "Louisiana"),
    "23": ("ME", "Maine"),           "24": ("MD", "Maryland"),
    "25": ("MA", "Massachusetts"),   "26": ("MI", "Michigan"),
    "27": ("MN", "Minnesota"),       "28": ("MS", "Mississippi"),
    "29": ("MO", "Missouri"),        "30": ("MT", "Montana"),
    "31": ("NE", "Nebraska"),        "32": ("NV", "Nevada"),
    "33": ("NH", "New Hampshire"),   "34": ("NJ", "New Jersey"),
    "35": ("NM", "New Mexico"),      "36": ("NY", "New York"),
    "37": ("NC", "North Carolina"),  "38": ("ND", "North Dakota"),
    "39": ("OH", "Ohio"),            "40": ("OK", "Oklahoma"),
    "41": ("OR", "Oregon"),          "42": ("PA", "Pennsylvania"),
    "44": ("RI", "Rhode Island"),    "45": ("SC", "South Carolina"),
    "46": ("SD", "South Dakota"),    "47": ("TN", "Tennessee"),
    "48": ("TX", "Texas"),           "49": ("UT", "Utah"),
    "50": ("VT", "Vermont"),         "51": ("VA", "Virginia"),
    "53": ("WA", "Washington"),      "54": ("WV", "West Virginia"),
    "55": ("WI", "Wisconsin"),       "56": ("WY", "Wyoming"),
    # Territories with FIPS
    "60": ("AS", "American Samoa"),
    "66": ("GU", "Guam"),
    "69": ("MP", "Northern Mariana Islands"),
    "72": ("PR", "Puerto Rico"),
    "78": ("VI", "U.S. Virgin Islands"),
}


def _post(url: str, params: dict[str, str], retries: int = 5) -> dict:
    body = urllib.parse.urlencode(params).encode()
    headers = {
        "User-Agent": UA,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    req = urllib.request.Request(url, data=body, headers=headers)
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


def _ring_centroid(rings: list[list[list[float]]]) -> tuple[float, float]:
    xs, ys = [], []
    for ring in rings:
        for x, y in ring:
            xs.append(x); ys.append(y)
    return sum(xs) / len(xs), sum(ys) / len(ys)


def fetch_states() -> list[dict]:
    """Pull every state record from layer 1 and filter to US."""
    print("Fetching state polygons (paginated)...")
    rows: list[dict] = []
    offset = 0
    PAGE = 200
    while True:
        page = _post(STATES, {
            "where": "1=1",
            "outFields": "plant_location_id,country_subdivision_name",
            "returnGeometry": "false",
            "orderByFields": "plant_location_id",
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE),
            "f": "json",
        })
        feats = page.get("features", [])
        if not feats:
            break
        rows.extend(f["attributes"] for f in feats)
        offset += len(feats)
        if len(feats) < PAGE:
            break

    # Match returned names to our US_STATES table to filter to US + assign codes.
    by_name = {state_name: (state_fips, state_code) for state_fips, (state_code, state_name) in US_STATES.items()}
    out: list[dict] = []
    for r in rows:
        name = (r.get("country_subdivision_name") or "").strip()
        if name not in by_name:
            continue
        fips, code = by_name[name]
        out.append({
            "state_code": code,
            "state_name": name,
            "state_fips": fips,
            "country":    "US",
            "usda_plant_location_id": r.get("plant_location_id"),
        })
    print(f"  matched {len(out)} US states / territories")
    return sorted(out, key=lambda r: r["state_code"])


def fetch_counties() -> list[dict]:
    """Paginate every county feature, geometry included, derive centroid."""
    print("Fetching all county polygons (paginated; ~3,150 counties)...")
    rows: list[dict] = []
    offset = 0
    PAGE = 500
    while True:
        page = _post(COUNTIES, {
            "where": "1=1",
            "outFields": "plant_location_id,country_subdivision_name,country_subdivision_code",
            "returnGeometry": "true",
            "outSR": "4326",
            "orderByFields": "plant_location_id",
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE),
            "f": "json",
        })
        feats = page.get("features", [])
        if not feats:
            break
        for f in feats:
            attrs = f.get("attributes", {})
            code  = attrs.get("country_subdivision_code")
            if not code or len(code) != 5 or not code.isdigit():
                continue  # not US-FIPS
            state_fips = code[:2]
            if state_fips not in US_STATES:
                continue
            state_code, _ = US_STATES[state_fips]
            geom = f.get("geometry") or {}
            rings = geom.get("rings") or []
            lat = lon = None
            if rings:
                lon, lat = _ring_centroid(rings)
            rows.append({
                "county_fips": code,
                "county_name": attrs.get("country_subdivision_name"),
                "state_code":  state_code,
                "usda_plant_location_id": attrs.get("plant_location_id"),
                "centroid_lat": round(lat, 5) if lat is not None else None,
                "centroid_lon": round(lon, 5) if lon is not None else None,
            })
        offset += len(feats)
        print(f"  {offset:>5} fetched")
        if len(feats) < PAGE:
            break

    rows.sort(key=lambda r: (r["state_code"], r["county_name"] or ""))
    print(f"  {len(rows)} US counties")
    return rows


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)

    states = fetch_states()
    (RAW / "states.json").write_text(json.dumps(states, indent=2))
    print(f"Wrote raw/states.json ({len(states)} states/territories)")

    counties = fetch_counties()
    (RAW / "counties.json").write_text(json.dumps(counties, indent=2))
    print(f"Wrote raw/counties.json ({len(counties)} counties)")


if __name__ == "__main__":
    main()
