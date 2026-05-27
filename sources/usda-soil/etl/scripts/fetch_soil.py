"""Fetch SSURGO soil data for every US county centroid via USDA SDA.

Two-phase pull:

  Phase 1 — county_fips → mukey
    Batched UNION ALL queries hit `SDA_Get_Mukey_from_intersection_with_WktWgs84`
    at each county centroid. ~50 centroids per request, ~65 round-trips for
    the nationwide set.

  Phase 2 — mukey → components + surface horizons
    For each distinct mukey, fetch component composition + surface horizon
    (hzdept_r=0) attributes. Batched ~300 mukeys per request.

Outputs per-county cached JSON at `raw/county_soil/{fips}.json` so re-runs
are idempotent and partial fetches resume.

Reads county centroids from the USDA Plants chunk
(`../../usda-plants/etl/processed/usda_plants.db`) — we already have lat/lon
for every county there, no need to re-fetch them.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = "rootfast/0.1.0"
SDA = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest"

ETL_ROOT  = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]
RAW       = ETL_ROOT / "raw"
COUNTY_DIR = RAW / "county_soil"

USDA_PLANTS_DB = REPO_ROOT / "sources" / "usda-plants" / "etl" / "processed" / "usda_plants.db"


def sda_query(sql: str, retries: int = 5) -> list[list]:
    """POST a SELECT to SDA, return the rows (header included as row 0)."""
    body = urllib.parse.urlencode({"query": sql, "format": "JSON+COLUMNNAME"}).encode()
    req = urllib.request.Request(
        SDA,
        data=body,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read()).get("Table", [])
        except urllib.error.HTTPError as e:
            # 5xx + 429 → retry with backoff. 400 means a SQL error, surface it.
            if e.code not in (429, 500, 502, 503, 504):
                msg = e.read().decode("utf-8", "replace")[:500]
                raise RuntimeError(f"SDA HTTP {e.code}: {msg}") from e
            last_err = e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
        time.sleep(2 ** attempt)
    assert last_err is not None
    raise last_err


def load_centroids() -> list[tuple[str, float, float, str, str]]:
    """[(fips, lat, lon, county_name, state_code), ...] for all US counties
    with usable centroids."""
    if not USDA_PLANTS_DB.exists():
        sys.exit(f"Missing {USDA_PLANTS_DB}. Run usda-plants build first.")
    db = sqlite3.connect(USDA_PLANTS_DB)
    rows = db.execute(
        """SELECT county_fips, centroid_lat, centroid_lon, county_name, state_code
             FROM counties
            WHERE centroid_lat IS NOT NULL AND centroid_lon IS NOT NULL
         ORDER BY county_fips"""
    ).fetchall()
    db.close()
    return [(r[0], float(r[1]), float(r[2]), r[3], r[4]) for r in rows]


# ---------------------------------------------------------------------------
# Phase 1: point → mukey
# ---------------------------------------------------------------------------

def fetch_mukeys(centroids: list[tuple[str, float, float, str, str]]) -> dict[str, int | None]:
    """Returns {fips: mukey | None}. Caches results to raw/fips_to_mukey.json."""
    cache_path = RAW / "fips_to_mukey.json"
    cache: dict[str, int | None] = {}
    if cache_path.exists():
        cache = {k: (int(v) if v is not None else None) for k, v in json.loads(cache_path.read_bytes()).items()}
        print(f"  cache: {len(cache)} fips→mukey entries already on disk")

    missing = [c for c in centroids if c[0] not in cache]
    if not missing:
        print("  all mukeys already cached")
        return cache

    print(f"  fetching mukey for {len(missing)} centroids in batches…")
    BATCH = 50
    for i in range(0, len(missing), BATCH):
        chunk = missing[i : i + BATCH]
        # SDA's `SDA_Get_Mukey_from_intersection_with_WktWgs84` is a TVF;
        # we want one (fips, mukey) row per centroid. UNION ALL covers it.
        parts = []
        for fips, lat, lon, *_ in chunk:
            parts.append(
                f"SELECT '{fips}' AS fips, mukey "
                f"FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point({lon} {lat})')"
            )
        sql = " UNION ALL ".join(parts)

        rows = sda_query(sql)
        # rows[0] is the header row [['fips','mukey']]; the rest are data.
        present_fips = set()
        for row in rows[1:]:
            fips, mukey = row[0], row[1]
            cache[fips] = int(mukey) if mukey and str(mukey).isdigit() else None
            present_fips.add(fips)
        # Counties whose point didn't intersect any mukey come back missing.
        for fips, *_ in chunk:
            if fips not in present_fips:
                cache[fips] = None

        cache_path.write_text(json.dumps({k: v for k, v in cache.items()}, indent=2))
        done = i + len(chunk)
        print(f"    {done}/{len(missing)} (cache now {len(cache)})")
        time.sleep(0.25)
    return cache


# ---------------------------------------------------------------------------
# Phase 2: mukey → component + surface horizon attributes
# ---------------------------------------------------------------------------

def fetch_mukey_details(mukeys: set[int]) -> dict[int, list[dict]]:
    """Returns {mukey: [ {comp, comppct, drainage, slope, sand, silt, clay, om, ph, awc, hzdept, hzdepb}, ... ]}.

    Caches per-mukey under raw/mukey_details/{mukey}.json."""
    cache_dir = RAW / "mukey_details"
    cache_dir.mkdir(parents=True, exist_ok=True)

    results: dict[int, list[dict]] = {}
    missing = []
    for mk in mukeys:
        p = cache_dir / f"{mk}.json"
        if p.exists() and p.stat().st_size > 0:
            results[mk] = json.loads(p.read_bytes())
        else:
            missing.append(mk)
    print(f"  cache: {len(results)} mukey details already on disk; {len(missing)} to fetch")

    if not missing:
        return results

    BATCH = 300
    for i in range(0, len(missing), BATCH):
        chunk = sorted(missing[i : i + BATCH])
        mukey_list = ",".join(str(m) for m in chunk)
        # Pull components + every horizon. Filter to horizons we want at
        # build time (we take the top 25 cm weighted-average).
        sql = (
            "SELECT c.mukey, mu.muname, c.cokey, c.compname, c.comppct_r, "
            "       c.compkind, c.drainagecl, c.slope_r, c.hydricrating, "
            "       h.hzdept_r, h.hzdepb_r, "
            "       h.sandtotal_r, h.silttotal_r, h.claytotal_r, "
            "       h.om_r, h.ph1to1h2o_r, h.awc_r "
            "  FROM mapunit AS mu "
            "  INNER JOIN component AS c ON c.mukey = mu.mukey "
            "  LEFT  JOIN chorizon  AS h ON h.cokey = c.cokey "
            f"WHERE c.mukey IN ({mukey_list}) "
            "ORDER BY c.mukey, c.comppct_r DESC, h.hzdept_r ASC"
        )

        rows = sda_query(sql)
        if not rows:
            print(f"    chunk {i//BATCH}: empty response")
            continue
        header = rows[0]
        # Cell-bag rows; we group by mukey and persist each.
        by_mukey: dict[int, list[dict]] = {}
        for row in rows[1:]:
            r = dict(zip(header, row))
            try:
                mk = int(r["mukey"])
            except (TypeError, ValueError):
                continue
            by_mukey.setdefault(mk, []).append(r)
        # Write each
        for mk in chunk:
            entries = by_mukey.get(mk, [])
            (cache_dir / f"{mk}.json").write_text(json.dumps(entries, indent=2))
            results[mk] = entries
        done = i + len(chunk)
        print(f"    {done}/{len(missing)} mukeys cached")
        time.sleep(0.25)
    return results


def write_per_county_summaries(
    centroids: list[tuple[str, float, float, str, str]],
    fips_to_mukey: dict[str, int | None],
    details: dict[int, list[dict]],
) -> None:
    """For each county write raw/county_soil/{fips}.json with the bundled
    components + horizons. Aggregation to a single row happens in
    build_sqlite.py."""
    COUNTY_DIR.mkdir(parents=True, exist_ok=True)
    n = 0
    for fips, lat, lon, county_name, state_code in centroids:
        mukey = fips_to_mukey.get(fips)
        entries = details.get(mukey, []) if mukey else []
        payload = {
            "county_fips": fips,
            "county_name": county_name,
            "state_code":  state_code,
            "centroid":    {"lat": lat, "lon": lon},
            "mukey":       mukey,
            "rows":        entries,
        }
        (COUNTY_DIR / f"{fips}.json").write_text(json.dumps(payload, indent=2))
        n += 1
    print(f"  wrote {n} county summaries to {COUNTY_DIR}")


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    print(f"[1/3] loading county centroids from {USDA_PLANTS_DB.name}")
    centroids = load_centroids()
    print(f"  {len(centroids)} counties with centroids")

    print(f"[2/3] fips → mukey via SDA")
    fips_to_mukey = fetch_mukeys(centroids)
    matched = sum(1 for v in fips_to_mukey.values() if v is not None)
    print(f"  {matched} / {len(centroids)} matched a mukey")

    print(f"[3/3] mukey → component + horizon details")
    unique_mukeys = {v for v in fips_to_mukey.values() if v}
    print(f"  {len(unique_mukeys)} unique mukeys to resolve")
    details = fetch_mukey_details(unique_mukeys)

    print(f"[done] writing per-county summaries to {COUNTY_DIR}")
    write_per_county_summaries(centroids, fips_to_mukey, details)


if __name__ == "__main__":
    main()
