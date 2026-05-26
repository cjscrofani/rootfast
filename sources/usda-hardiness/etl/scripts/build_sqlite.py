"""Build the USDA Hardiness source's SQLite chunk for the Rootfast API.

Reads the CSVs produced by fetch_hardiness.py and emits a fresh SQLite
file at processed/hardiness.db conforming to the Rootfast schema at
api/schema/003_hardiness.sql.

Owns three tables in the unified DB:
    hardiness_zones              canonical 1a–13b reference
    hardiness_zones_by_zip       40k+ ZIP → zone
    hardiness_zones_by_county    one row per US county → predominant zone

Reads:
    raw/zip_zones.csv      from fetch_hardiness.py step 1
    raw/county_zones.csv   from fetch_hardiness.py step 3

Writes:
    processed/hardiness.db
"""

from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

ETL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]
RAW = ETL_ROOT / "raw"
PROCESSED = ETL_ROOT / "processed"
OUT = PROCESSED / "hardiness.db"
SCHEMA_DIR = REPO_ROOT / "api" / "schema"

# Canonical hardiness zones. 1a (-60 to -55 °F) … 13b (65 to 70 °F).
# Each half-zone is a 5°F step; class_code 1=1a, 2=1b, …, 26=13b.
ZONES: list[tuple[str, int, float, float]] = []
_letters = ["a", "b"]
for i in range(13):
    n = i + 1
    base = -60 + i * 10  # 1a starts at -60, 2a at -50, …, 13a at 60
    for j, letter in enumerate(_letters):
        code = f"{n}{letter}"
        tmin = base + j * 5
        tmax = tmin + 5
        class_code = i * 2 + j + 1
        ZONES.append((code, class_code, float(tmin), float(tmax)))


def _zone_desc(code: str, tmin: float, tmax: float) -> str:
    fmt = lambda x: f"{int(x)}" if x == int(x) else f"{x}"
    return f"{code} ({fmt(tmin)} to {fmt(tmax)} °F)"


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
        db.executescript(migration.read_text())
    return db


def load_zones(db: sqlite3.Connection) -> None:
    db.execute("BEGIN")
    db.executemany(
        """INSERT OR REPLACE INTO hardiness_zones
             (zone_code, zone_class_code, temp_min_f, temp_max_f, description)
           VALUES (?, ?, ?, ?, ?)""",
        [
            (code, cc, tmin, tmax, _zone_desc(code, tmin, tmax))
            for code, cc, tmin, tmax in ZONES
        ],
    )
    db.execute("COMMIT")
    print(f"  hardiness_zones: {len(ZONES)} rows")


def load_zip_zones(db: sqlite3.Connection) -> int:
    path = RAW / "zip_zones.csv"
    if not path.exists():
        print(f"  ✗ {path.name} missing — run fetch_hardiness.py first")
        return 0
    # USDA's `ZONE_CODE` field is an opaque internal id, not "5a"-style.
    # Their `Class_Code` (1..26) is the actual zone index that maps to our
    # canonical zones table. Build a class_code → zone_code lookup.
    by_class_code = {cc: code for code, cc, *_ in ZONES}
    rows: list[tuple[str, str]] = []
    skipped = 0
    with path.open() as f:
        for row in csv.DictReader(f):
            zip_code = (row.get("zip_code") or "").strip()
            cc_raw = (row.get("zone_class_code") or "").strip()
            try:
                cc = int(cc_raw)
            except ValueError:
                skipped += 1
                continue
            zone = by_class_code.get(cc)
            if not zip_code or not zone:
                skipped += 1
                continue
            rows.append((zip_code, zone))
    db.execute("BEGIN")
    db.executemany(
        "INSERT OR REPLACE INTO hardiness_zones_by_zip (zip_code, zone_code) VALUES (?, ?)",
        rows,
    )
    db.execute("COMMIT")
    print(f"  hardiness_zones_by_zip: {len(rows)} rows (skipped {skipped})")
    return len(rows)


def load_county_zones(db: sqlite3.Connection) -> int:
    """Insert county-zone rows. The chunk doesn't own `counties` itself
    (usda-plants does), so FK validation here is informational only —
    api/scripts/build.py runs the cross-chunk FK check at merge time."""
    path = RAW / "county_zones.csv"
    if not path.exists():
        print(f"  ✗ {path.name} missing — run fetch_hardiness.py first")
        return 0
    valid_zones = {code for code, *_ in ZONES}
    rows: list[tuple[str, str]] = []
    skipped = 0
    with path.open() as f:
        for row in csv.DictReader(f):
            fips = (row.get("fips") or "").strip()
            zone = (row.get("zone_code") or "").strip()
            if not fips or not zone:
                skipped += 1
                continue
            if zone not in valid_zones:
                skipped += 1
                continue
            rows.append((fips, zone))

    # The hardiness chunk doesn't have counties rows; skipping FK
    # enforcement on insert means the chunk can be built standalone, and
    # the merge step will validate against the populated counties table.
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("BEGIN")
    db.executemany(
        "INSERT OR REPLACE INTO hardiness_zones_by_county (county_fips, zone_code) VALUES (?, ?)",
        rows,
    )
    db.execute("COMMIT")
    print(f"  hardiness_zones_by_county: {len(rows)} rows (skipped {skipped})")
    return len(rows)


def main() -> None:
    print(f"Building {OUT}")
    db = open_fresh_db()
    load_zones(db)
    load_zip_zones(db)
    load_county_zones(db)
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"\nFinal: {OUT} ({size_mb:.1f} MB)")
    db.close()


if __name__ == "__main__":
    main()
