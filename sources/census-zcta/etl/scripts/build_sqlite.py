"""Build the Census ZCTA source's SQLite chunk for the Rootfast API.

Reads the relationship file cached by fetch_zcta_counties.py and emits
processed/zcta.db conforming to api/schema/007_zip_counties.sql.

Owns one table in the unified DB:
    zip_counties    (zip_code, county_fips, land_share)

land_share is the fraction of the ZCTA's land area inside that county. For
the rare water-only ZCTA (land area 0 everywhere) we fall back to total area
so the shares still sum to 1. Rows whose county is unknown to the unified
schema (e.g. Connecticut's pre-2022 counties, which USDA has replaced with
planning regions) are dropped during the merge in api/scripts/build.py, not
here — this chunk is schema-agnostic about geography.

Reads:
    raw/tab20_zcta520_county20_natl.txt
Writes:
    processed/zcta.db
"""

from __future__ import annotations

import csv
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Iterable

ETL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]
RAW = ETL_ROOT / "raw"
PROCESSED = ETL_ROOT / "processed"
OUT = PROCESSED / "zcta.db"
SCHEMA_DIR = REPO_ROOT / "api" / "schema"
SRC = RAW / "tab20_zcta520_county20_natl.txt"


def compute_shares(rows: Iterable[dict[str, str]]) -> list[tuple[str, str, float]]:
    """Reduce relationship rows to (zip, county_fips, land_share) triples.

    Rows with an empty ZCTA (county area outside any ZCTA) are skipped. The
    share is land-area based; when a ZCTA has zero land area in every county
    (water-only), total area (land + water) is used instead so the shares
    still describe where the ZCTA sits.
    """
    land: dict[str, dict[str, float]] = defaultdict(dict)
    total: dict[str, dict[str, float]] = defaultdict(dict)
    for r in rows:
        zcta = (r.get("GEOID_ZCTA5_20") or "").strip()
        fips = (r.get("GEOID_COUNTY_20") or "").strip()
        if not zcta or not fips:
            continue
        a_land = float(r.get("AREALAND_PART") or 0)
        a_water = float(r.get("AREAWATER_PART") or 0)
        land[zcta][fips] = land[zcta].get(fips, 0.0) + a_land
        total[zcta][fips] = total[zcta].get(fips, 0.0) + a_land + a_water

    out: list[tuple[str, str, float]] = []
    for zcta in sorted(land):
        parts = land[zcta]
        denom = sum(parts.values())
        if denom <= 0:
            parts = total[zcta]
            denom = sum(parts.values())
        if denom <= 0:
            # Degenerate: no area at all. Split evenly so the ZIP still resolves.
            n = len(parts)
            out.extend((zcta, fips, round(1.0 / n, 6)) for fips in sorted(parts))
            continue
        for fips in sorted(parts, key=lambda f: (-parts[f], f)):
            out.append((zcta, fips, round(min(1.0, parts[fips] / denom), 6)))
    return out


def open_fresh_db() -> sqlite3.Connection:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()
    db = sqlite3.connect(OUT)
    db.isolation_level = None
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("PRAGMA journal_mode = OFF")
    db.execute("PRAGMA synchronous = OFF")
    # Apply every api/schema migration so the chunk's tables match the
    # unified schema exactly (the merge in api/scripts/build.py expects this).
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        db.executescript(migration.read_text(encoding="utf-8"))
    return db


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"  ✗ {SRC} missing — run fetch_zcta_counties.py first")
    print(f"Building {OUT}")
    with SRC.open(encoding="utf-8", newline="") as f:
        triples = compute_shares(csv.DictReader(f, delimiter="|"))
    db = open_fresh_db()
    db.execute("BEGIN")
    db.executemany(
        "INSERT OR REPLACE INTO zip_counties (zip_code, county_fips, land_share) VALUES (?, ?, ?)",
        triples,
    )
    db.execute("COMMIT")
    zips = db.execute("SELECT COUNT(DISTINCT zip_code) FROM zip_counties").fetchone()[0]
    multi = db.execute(
        "SELECT COUNT(*) FROM (SELECT zip_code FROM zip_counties GROUP BY zip_code HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    print(f"  zip_counties: {len(triples)} rows · {zips} ZIPs · {multi} span more than one county")
    db.close()
    print(f"Final: {OUT} ({OUT.stat().st_size / (1024 * 1024):.1f} MB)")


if __name__ == "__main__":
    main()
