"""Merge every source SQLite chunk into one rootfast.db for D1.

Each pipeline under sources/*/etl/ produces a SQLite file conforming to
api/schema/001_initial.sql. This script reads them all and emits one
unified DB at api/processed/rootfast.db, plus a .sql dump suitable for
wrangler.

For v1 (USDA Plants only) this is essentially a pass-through copy. When
sibling sources land (usda-hardiness joins on county_fips; iNaturalist,
Wikidata, GBIF occurrences join on gbif_taxon_key) this script gains
real merge logic.

Outputs:
    api/processed/rootfast.db       built SQLite, ready for inspection
    api/processed/rootfast.sql      SQL dump for wrangler d1 execute
"""

from __future__ import annotations

import sqlite3
import subprocess
import sys
from pathlib import Path

# api/scripts/X.py → api/scripts → api/
API_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = API_ROOT.parent

SCHEMA_DIR = API_ROOT / "schema"
PROCESSED = API_ROOT / "processed"
OUT_DB = PROCESSED / "rootfast.db"
OUT_SQL = PROCESSED / "rootfast.sql"           # full dump (schema + data)
OUT_DATA_SQL = PROCESSED / "rootfast_data.sql"  # INSERTs only (for use after migrations)

# Sources to merge. Each is (logical_name, path_to_chunk).
# Order matters when sources share tables — earlier wins on row PK conflict.
SOURCES: list[tuple[str, Path]] = [
    ("usda_plants",    REPO_ROOT / "sources" / "usda-plants"    / "etl" / "processed" / "usda_plants.db"),
    ("usda_hardiness", REPO_ROOT / "sources" / "usda-hardiness" / "etl" / "processed" / "hardiness.db"),
    # ("inaturalist",  REPO_ROOT / "sources" / "inaturalist"    / "etl" / "processed" / "inaturalist.db"),
]

# Tables in FK dependency order (parents before children).
# Used both to copy in the right order and to print per-table counts.
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


def open_fresh_db() -> sqlite3.Connection:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    if OUT_DB.exists():
        OUT_DB.unlink()
    db = sqlite3.connect(OUT_DB)
    db.isolation_level = None  # autocommit; we manage txns explicitly
    db.execute("PRAGMA foreign_keys = OFF")  # bulk-load mode; enabled at end
    db.execute("PRAGMA journal_mode = OFF")
    db.execute("PRAGMA synchronous = OFF")
    # Apply all migrations in numerical order so this stays in sync with D1.
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        db.executescript(migration.read_text())
    return db


def merge_source(db: sqlite3.Connection, name: str, src_path: Path) -> dict[str, int]:
    if not src_path.exists():
        print(f"  ✗ skipping {name}: {src_path} missing")
        return {}

    print(f"  Merging {name} from {src_path.name} ({src_path.stat().st_size / 1024 / 1024:.1f} MB)")
    db.execute(f"ATTACH DATABASE '{src_path}' AS src")
    db.execute("BEGIN")

    counts: dict[str, int] = {}
    src_tables = {
        r[0] for r in db.execute("SELECT name FROM src.sqlite_master WHERE type='table'").fetchall()
    }

    for tbl in TABLE_ORDER:
        if tbl not in src_tables:
            continue
        row = db.execute(f"SELECT COUNT(*) FROM src.{tbl}").fetchone()
        n = row[0]
        if n == 0:
            continue
        # INSERT OR IGNORE so a second source can contribute new rows for
        # tables it shares with the first (e.g., another source adding more
        # regions or states); rows that conflict on PK are skipped silently.
        db.execute(f"INSERT OR IGNORE INTO {tbl} SELECT * FROM src.{tbl}")
        # Actual inserted count = main table count diff before/after; we
        # report the source-side count for simplicity here.
        counts[tbl] = n

    db.execute("COMMIT")
    db.execute("DETACH DATABASE src")
    return counts


def reenable_fks_and_verify(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA foreign_keys = ON")
    violations = db.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        print(f"\n  ✗ FK violations ({len(violations)}): {violations[:5]}{' …' if len(violations) > 5 else ''}")
        sys.exit(1)
    # Quick integrity check.
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        print(f"\n  ✗ Integrity check failed: {integrity}")
        sys.exit(1)
    print("  ✓ FK check + integrity check passed")


def write_sql_dump() -> None:
    """Use the sqlite3 CLI to write a .sql dump alongside the .db.

    Wrangler ingests via `wrangler d1 execute --file=...` which expects SQL,
    not a binary SQLite file.
    """
    try:
        with OUT_SQL.open("w") as f:
            subprocess.run(
                ["sqlite3", str(OUT_DB), ".dump"],
                stdout=f,
                check=True,
            )
        print(f"  SQL dump (full):     {OUT_SQL} ({OUT_SQL.stat().st_size / 1024 / 1024:.1f} MB)")
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  ✗ Could not produce SQL dump ({e}); wrangler push will need .db directly")


def _sql_literal(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, bytes):
        return "X'" + v.hex() + "'"
    s = str(v).replace("'", "''")
    return f"'{s}'"


# Tables to EXCLUDE from the data-only dump:
#   schema_meta — seeded by the migration, INSERTing again would PK-conflict
#   plants_fts* — virtual / shadow tables; the FTS5 triggers on `plants`
#                 auto-populate plants_fts when we INSERT INTO plants.
_DATA_EXCLUDE = {
    "schema_meta",
    "plants_fts",
    "plants_fts_config",
    "plants_fts_data",
    "plants_fts_docsize",
    "plants_fts_idx",
    "sqlite_sequence",
}


def write_data_only_sql(db: sqlite3.Connection) -> None:
    """Produce a SQL file with only INSERT statements, in FK-safe order.

    For use AFTER `wrangler d1 migrations apply` — the schema is already
    in place; this just loads data.
    """
    with OUT_DATA_SQL.open("w") as f:
        f.write("-- rootfast data load. Generated by api/scripts/build.py.\n")
        f.write("-- Apply AFTER `wrangler d1 migrations apply rootfast`.\n")
        f.write("-- Idempotent: existing rows are deleted before inserting.\n")
        f.write("--\n")
        f.write("-- No BEGIN/COMMIT wrapping — D1 forbids explicit transactions in\n")
        f.write("-- SQL files (Durable Objects manage transactions internally).\n")
        f.write("-- Local SQLite handles this fine without explicit BEGIN too.\n\n")

        # Wipe in reverse FK-dependency order so children go before parents.
        f.write("-- Clear existing data (reverse dependency order).\n")
        for tbl in reversed(TABLE_ORDER):
            if tbl in _DATA_EXCLUDE:
                continue
            f.write(f"DELETE FROM {tbl};\n")
        f.write("\n")

        for tbl in TABLE_ORDER:
            if tbl in _DATA_EXCLUDE:
                continue
            cols_info = db.execute(f"PRAGMA table_info({tbl})").fetchall()
            cols = [c[1] for c in cols_info]
            col_list = ",".join(cols)
            rows = db.execute(f"SELECT {col_list} FROM {tbl}").fetchall()
            if not rows:
                continue
            f.write(f"-- {tbl}: {len(rows)} rows\n")
            for row in rows:
                values = ",".join(_sql_literal(v) for v in row)
                f.write(f"INSERT INTO {tbl} ({col_list}) VALUES ({values});\n")

    size_mb = OUT_DATA_SQL.stat().st_size / (1024 * 1024)
    print(f"  SQL dump (data-only): {OUT_DATA_SQL} ({size_mb:.1f} MB)")


def validate(db: sqlite3.Connection) -> None:
    print("\n=== Validation ===")
    print(f"plants total: {db.execute('SELECT COUNT(*) FROM plants').fetchone()[0]}")
    print(f"plants with GBIF: {db.execute('SELECT COUNT(*) FROM plants WHERE gbif_taxon_key IS NOT NULL').fetchone()[0]}")
    print(f"distribution rows: {db.execute('SELECT COUNT(*) FROM plant_county_distribution').fetchone()[0]}")
    print(f"characteristics rows: {db.execute('SELECT COUNT(*) FROM plant_characteristics').fetchone()[0]}")
    # Hardiness (present only after migration 003 is in place and the source ran)
    try:
        z   = db.execute('SELECT COUNT(*) FROM hardiness_zones').fetchone()[0]
        zip_ = db.execute('SELECT COUNT(*) FROM hardiness_zones_by_zip').fetchone()[0]
        cty = db.execute('SELECT COUNT(*) FROM hardiness_zones_by_county').fetchone()[0]
        print(f"hardiness zones: {z}; ZIPs: {zip_}; counties: {cty}")
    except sqlite3.OperationalError:
        pass

    print("\n--- Filter query: drought-tolerant native trees in Gallatin County, MT ---")
    cur = db.execute(
        """SELECT p.usda_symbol, p.common_name
             FROM plants p
             JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
             JOIN plant_growth_habits        pgh ON pgh.plant_id = p.id
             JOIN plant_characteristics      pc  ON pc.plant_id = p.id
            WHERE pcd.county_fips = '30031'
              AND pcd.nativity = 'Native'
              AND pgh.growth_habit = 'Tree'
              AND pc.drought_tolerance = 'High'
            ORDER BY p.scientific_name LIMIT 5"""
    )
    for sym, name in cur:
        print(f"  {sym:8} {name}")


def main() -> None:
    print(f"Building {OUT_DB}")
    migrations = sorted(p.name for p in SCHEMA_DIR.glob("*.sql"))
    print(f"  Schema:  {len(migrations)} migrations from {SCHEMA_DIR.relative_to(REPO_ROOT)}/ — {', '.join(migrations)}")
    print(f"  Sources: {len(SOURCES)}")

    db = open_fresh_db()
    for name, path in SOURCES:
        merge_source(db, name, path)

    reenable_fks_and_verify(db)
    validate(db)

    size_mb = OUT_DB.stat().st_size / (1024 * 1024)
    print(f"\nFinal: {OUT_DB} ({size_mb:.1f} MB)")
    write_sql_dump()
    write_data_only_sql(db)
    db.close()

    print(
        "\nNext: push to D1 (schema via migrations, data via data-only dump)\n"
        "    npx wrangler d1 migrations apply rootfast --local\n"
        "    npx wrangler d1 execute   rootfast --local  --file=processed/rootfast_data.sql\n"
        "    # ...then for remote:\n"
        "    npx wrangler d1 migrations apply rootfast --remote\n"
        "    npx wrangler d1 import           rootfast --remote --file=processed/rootfast_data.sql"
    )


if __name__ == "__main__":
    main()
