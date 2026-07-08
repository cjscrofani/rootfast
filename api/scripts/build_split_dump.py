"""Emit the data-only SQL dump split into two files that each stay
under wrangler's R2-upload threshold (~400MB).

  rootfast_part_a.sql  — every data table except plant_county_distribution.
                         DELETEs all data tables (so previous distribution
                         is cleared too), then INSERTs everything except
                         plant_county_distribution.
  rootfast_part_b.sql  — plant_county_distribution INSERTs only.

Push order matters: Part A first (since it issues DELETEs), Part B second.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent
PROCESSED = API_ROOT / "processed"
SRC_DB = PROCESSED / "rootfast.db"
OUT_A = PROCESSED / "rootfast_part_a.sql"
OUT_B = PROCESSED / "rootfast_part_b.sql"

# Order matches api/scripts/build.py — DELETEs run reverse, INSERTs forward.
TABLE_ORDER = [
    "regions",
    "states",
    "counties",
    "plants",
    "plant_growth_habits",
    "plant_durations",
    "plant_common_names",
    "plant_native_status",
    "plant_county_distribution",
    "plant_characteristics",
    "plant_wildlife_value",
    "plant_wetland_indicators",
    "plant_synonyms",
    "plant_status",
    "plant_external_references",
    "hardiness_zones",
    "hardiness_zones_by_zip",
    "hardiness_zones_by_county",
    "soil_by_county",
]

_DATA_EXCLUDE = {
    "schema_meta",
    "plants_fts","plants_fts_config","plants_fts_data","plants_fts_docsize","plants_fts_idx",
    "sqlite_sequence",
}

BULKY = "plant_county_distribution"


def _lit(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def main() -> None:
    db = sqlite3.connect(SRC_DB)

    # ---- Part A: DELETEs (all) + INSERTs (all except BULKY) -------------
    with OUT_A.open("w") as f:
        f.write("-- Part A — DELETE all data tables; INSERT every table EXCEPT plant_county_distribution.\n")
        for tbl in reversed(TABLE_ORDER):
            if tbl in _DATA_EXCLUDE:
                continue
            f.write(f"DELETE FROM {tbl};\n")
        for tbl in TABLE_ORDER:
            if tbl in _DATA_EXCLUDE or tbl == BULKY:
                continue
            cols = [c[1] for c in db.execute(f"PRAGMA table_info({tbl})").fetchall()]
            col_list = ",".join(cols)
            rows = db.execute(f"SELECT {col_list} FROM {tbl}").fetchall()
            if not rows:
                continue
            f.write(f"-- {tbl}: {len(rows)} rows\n")
            for row in rows:
                f.write(f"INSERT INTO {tbl} ({col_list}) VALUES ({','.join(_lit(v) for v in row)});\n")
    size_a_mb = OUT_A.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT_A.name} ({size_a_mb:.1f} MB)")

    # ---- Part B: INSERT plant_county_distribution -----------------------
    cols = [c[1] for c in db.execute(f"PRAGMA table_info({BULKY})").fetchall()]
    col_list = ",".join(cols)
    rows = db.execute(f"SELECT {col_list} FROM {BULKY}").fetchall()
    with OUT_B.open("w") as f:
        f.write(f"-- Part B — {BULKY} only.\n")
        f.write(f"-- {BULKY}: {len(rows)} rows\n")
        for row in rows:
            f.write(f"INSERT INTO {BULKY} ({col_list}) VALUES ({','.join(_lit(v) for v in row)});\n")
    size_b_mb = OUT_B.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT_B.name} ({size_b_mb:.1f} MB)")
    db.close()


if __name__ == "__main__":
    main()
