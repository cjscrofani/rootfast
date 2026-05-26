"""Emit a SQL file that loads ONLY hardiness data into D1.

A small targeted import for when the full rootfast_data.sql is too large
for wrangler's R2-upload path. Touches only the three hardiness tables:
DELETEs them, then INSERTs from sources/usda-hardiness/etl/processed/hardiness.db.
Leaves every other table untouched in the remote DB.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = API_ROOT.parent

SRC = REPO_ROOT / "sources" / "usda-hardiness" / "etl" / "processed" / "hardiness.db"
OUT = API_ROOT / "processed" / "rootfast_hardiness.sql"

TABLES = [
    "hardiness_zones",
    "hardiness_zones_by_zip",
    "hardiness_zones_by_county",
]


def _lit(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def main() -> None:
    db = sqlite3.connect(SRC)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        f.write("-- hardiness-only data load.\n")
        # Wipe in reverse-FK order: children before parents.
        for tbl in reversed(TABLES):
            f.write(f"DELETE FROM {tbl};\n")
        for tbl in TABLES:
            cols = [c[1] for c in db.execute(f"PRAGMA table_info({tbl})").fetchall()]
            col_list = ",".join(cols)
            rows = db.execute(f"SELECT {col_list} FROM {tbl}").fetchall()
            if not rows:
                continue
            f.write(f"-- {tbl}: {len(rows)} rows\n")
            for row in rows:
                values = ",".join(_lit(v) for v in row)
                f.write(f"INSERT INTO {tbl} ({col_list}) VALUES ({values});\n")
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
