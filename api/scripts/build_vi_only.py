"""Emit just the VI-specific bits as a small idempotent SQL file.

Used to patch D1 after the states.json fix when re-running the full
115-chunk push would be wasteful. Touches:
  states          (one row: VI)
  counties        (three rows: VI's three islands)
  plant_county_distribution (VI's rows; safe to re-run via OR IGNORE)
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

API_ROOT  = Path(__file__).resolve().parent.parent
SRC_DB    = API_ROOT / "processed" / "rootfast.db"
OUT       = API_ROOT / "processed" / "rootfast_vi.sql"


def _lit(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def main() -> None:
    db = sqlite3.connect(SRC_DB)
    OUT.parent.mkdir(parents=True, exist_ok=True)

    with OUT.open("w", encoding="utf-8") as f:
        f.write("-- VI delta: states/counties/distribution rows.\n")

        # states row
        cols = [c[1] for c in db.execute("PRAGMA table_info(states)").fetchall()]
        row = db.execute(
            f"SELECT {','.join(cols)} FROM states WHERE state_code='VI'"
        ).fetchone()
        if row:
            f.write(f"INSERT OR IGNORE INTO states ({','.join(cols)}) VALUES "
                    f"({','.join(_lit(v) for v in row)});\n")

        # counties rows (3)
        cols = [c[1] for c in db.execute("PRAGMA table_info(counties)").fetchall()]
        rows = db.execute(
            f"SELECT {','.join(cols)} FROM counties WHERE state_code='VI'"
        ).fetchall()
        for row in rows:
            f.write(f"INSERT OR IGNORE INTO counties ({','.join(cols)}) VALUES "
                    f"({','.join(_lit(v) for v in row)});\n")

        # distribution rows — only those whose county lives in VI
        cols = ["plant_id", "county_fips", "nativity"]
        rows = db.execute(
            "SELECT pcd.plant_id, pcd.county_fips, pcd.nativity "
            "  FROM plant_county_distribution pcd "
            "  JOIN counties c ON c.county_fips = pcd.county_fips "
            " WHERE c.state_code = 'VI'"
        ).fetchall()
        f.write(f"-- plant_county_distribution (VI): {len(rows)} rows\n")
        for row in rows:
            f.write(f"INSERT OR IGNORE INTO plant_county_distribution ({','.join(cols)}) VALUES "
                    f"({','.join(_lit(v) for v in row)});\n")

    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
