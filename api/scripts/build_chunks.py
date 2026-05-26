"""Emit the full data dump as many SMALL SQL chunks (~25 MB each).

Each chunk fits comfortably under D1's single-roundtrip ingest path —
no R2-upload-and-poll dance, no Node-25 fetch failures. Push them with
`wrangler d1 execute --remote --file=...` one at a time.

Layout in api/processed/chunks/:
    000_clear.sql                   DELETE FROM every data table (reverse FK)
    001_seed_small.sql              All small parent tables in one shot
    010_plants_xxxxxx.sql           plants in batches
    020_plant_growth_habits_xxx.sql each child table batched
    ...
    090_plant_county_distribution_xxxxxx.sql
    099_hardiness.sql               hardiness_zones + by_zip + by_county
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent
PROCESSED = API_ROOT / "processed"
SRC_DB = PROCESSED / "rootfast.db"
OUT_DIR = PROCESSED / "chunks"

CHUNK_BYTES = 4 * 1024 * 1024  # 4 MB target chunk size

# FK-safe order. DELETEs run in reverse.
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
]

# Tables small enough to bundle into one seed chunk.
SMALL = {"regions", "states", "counties"}


def _lit(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def write_chunk(chunks_dir: Path, idx: int, name_hint: str, content: str) -> None:
    chunks_dir.mkdir(parents=True, exist_ok=True)
    path = chunks_dir / f"{idx:03d}_{name_hint}.sql"
    path.write_text(content)
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"  {path.name} ({size_mb:.1f} MB)")


def main() -> None:
    if not SRC_DB.exists():
        sys.exit(f"missing {SRC_DB} — run api/scripts/build.py first")
    db = sqlite3.connect(SRC_DB)

    # Clear out old chunks (idempotent rebuild).
    if OUT_DIR.exists():
        for old in OUT_DIR.iterdir():
            if old.suffix == ".sql":
                old.unlink()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Writing chunks to {OUT_DIR}")

    idx = 0

    # 000 — DELETE everything (reverse FK order).
    parts = [f"DELETE FROM {t};" for t in reversed(TABLE_ORDER)]
    write_chunk(OUT_DIR, idx, "clear", "\n".join(parts) + "\n")
    idx += 1

    # 001 — Seed small parent tables in one chunk (regions/states/counties).
    seed_lines: list[str] = []
    for tbl in TABLE_ORDER:
        if tbl not in SMALL:
            continue
        cols = [c[1] for c in db.execute(f"PRAGMA table_info({tbl})").fetchall()]
        col_list = ",".join(cols)
        rows = db.execute(f"SELECT {col_list} FROM {tbl}").fetchall()
        if not rows:
            continue
        seed_lines.append(f"-- {tbl}: {len(rows)} rows")
        for row in rows:
            seed_lines.append(f"INSERT OR IGNORE INTO {tbl} ({col_list}) VALUES ({','.join(_lit(v) for v in row)});")
    write_chunk(OUT_DIR, idx, "seed_small", "\n".join(seed_lines) + "\n")
    idx += 1

    # Remaining tables: batch each into ~25MB chunks.
    for tbl in TABLE_ORDER:
        if tbl in SMALL:
            continue
        cols = [c[1] for c in db.execute(f"PRAGMA table_info({tbl})").fetchall()]
        col_list = ",".join(cols)
        rows = db.execute(f"SELECT {col_list} FROM {tbl}")
        buf: list[str] = []
        buf_bytes = 0
        part = 0
        header = f"-- {tbl}\n"
        buf.append(header)
        buf_bytes += len(header)
        for row in rows:
            line = f"INSERT OR IGNORE INTO {tbl} ({col_list}) VALUES ({','.join(_lit(v) for v in row)});\n"
            line_bytes = len(line.encode("utf-8"))
            if buf_bytes + line_bytes > CHUNK_BYTES and len(buf) > 1:
                write_chunk(OUT_DIR, idx, f"{tbl}_{part:03d}", "".join(buf))
                idx += 1
                part += 1
                buf = [header]
                buf_bytes = len(header)
            buf.append(line)
            buf_bytes += line_bytes
        if len(buf) > 1:
            write_chunk(OUT_DIR, idx, f"{tbl}_{part:03d}", "".join(buf))
            idx += 1

    db.close()
    total = sum(p.stat().st_size for p in OUT_DIR.glob("*.sql"))
    print(f"\nTotal: {idx} chunks, {total / (1024*1024):.1f} MB")


if __name__ == "__main__":
    main()
