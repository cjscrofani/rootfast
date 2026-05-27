"""Emit just the SSURGO soil rows as a small idempotent SQL file.

Used to patch D1 with soil data without re-pushing the full ~115-chunk
plant dataset. Touches only the `soil_by_county` table — DELETE + INSERT.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

API_ROOT  = Path(__file__).resolve().parent.parent
REPO_ROOT = API_ROOT.parent
SRC_DB    = REPO_ROOT / "sources" / "usda-soil" / "etl" / "processed" / "soil.db"
OUT       = API_ROOT  / "processed" / "rootfast_soil.sql"


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
    cols = [c[1] for c in db.execute("PRAGMA table_info(soil_by_county)").fetchall()]
    col_list = ",".join(cols)
    rows = db.execute(f"SELECT {col_list} FROM soil_by_county").fetchall()
    with OUT.open("w") as f:
        f.write("-- Soil delta — DELETE + INSERT for soil_by_county.\n")
        f.write("DELETE FROM soil_by_county;\n")
        f.write(f"-- soil_by_county: {len(rows)} rows\n")
        for row in rows:
            f.write(
                f"INSERT OR IGNORE INTO soil_by_county ({col_list}) VALUES "
                f"({','.join(_lit(v) for v in row)});\n"
            )
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
