"""Package a built rootfast.db into versioned, downloadable release artifacts.

Given the unified SQLite database, emit:
  <out>/rootfast.sqlite.gz        the whole database, gzipped
  <out>/parquet/<table>.parquet   one Parquet file per data table
  <out>/rootfast-parquet.zip      the Parquet directory, zipped
  <out>/manifest.json             schema version, per-table row counts, and a
                                  sha256 for every artifact

Heavy consumers download these instead of paginating the API. Parquet lets
analysts load the whole catalogue into DuckDB / pandas / Spark in one read.

Usage:
    python export_release.py <rootfast.db> <out_dir> --tag data-vYYYY.MM

Requires pandas + pyarrow (declared in sources/usda-plants/etl/pyproject.toml).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import zipfile
from pathlib import Path

# Shadow / virtual / bookkeeping tables that shouldn't ship as data.
_SKIP = {
    "sqlite_sequence",
    "plants_fts",
    "plants_fts_config",
    "plants_fts_data",
    "plants_fts_docsize",
    "plants_fts_idx",
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _data_tables(db: sqlite3.Connection) -> list[str]:
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows if r[0] not in _SKIP and not r[0].startswith("sqlite_")]


def _schema_version(db: sqlite3.Connection) -> str | None:
    try:
        row = db.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        return row[0] if row else None
    except sqlite3.OperationalError:
        return None


def export(db_path: Path, out_dir: Path, tag: str) -> dict:
    import pandas as pd  # imported lazily so --help works without the dep

    if not db_path.exists():
        raise SystemExit(f"missing database: {db_path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    parquet_dir = out_dir / "parquet"
    parquet_dir.mkdir(exist_ok=True)

    db = sqlite3.connect(db_path)
    schema_version = _schema_version(db)
    tables = _data_tables(db)

    row_counts: dict[str, int] = {}
    for tbl in tables:
        df = pd.read_sql_query(f"SELECT * FROM {tbl}", db)
        row_counts[tbl] = int(len(df))
        df.to_parquet(parquet_dir / f"{tbl}.parquet", index=False)
        print(f"  parquet {tbl}: {len(df):,} rows")
    db.close()

    # Gzip the whole SQLite file.
    sqlite_gz = out_dir / "rootfast.sqlite.gz"
    with db_path.open("rb") as src, gzip.open(sqlite_gz, "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
    print(f"  gzipped sqlite: {sqlite_gz.stat().st_size / 1e6:.1f} MB")

    # Zip the Parquet directory.
    parquet_zip = out_dir / "rootfast-parquet.zip"
    with zipfile.ZipFile(parquet_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for pq in sorted(parquet_dir.glob("*.parquet")):
            zf.write(pq, arcname=f"parquet/{pq.name}")
    print(f"  zipped parquet: {parquet_zip.stat().st_size / 1e6:.1f} MB")

    artifacts = []
    for art in (sqlite_gz, parquet_zip):
        artifacts.append({
            "name": art.name,
            "bytes": art.stat().st_size,
            "sha256": _sha256(art),
        })

    manifest = {
        "tag": tag,
        "schema_version": schema_version,
        "source": "Cloudflare D1 (production), exported via api/scripts/export_release.py",
        "license": "CC0 1.0 (data)",
        "total_rows": sum(row_counts.values()),
        "table_row_counts": row_counts,
        "artifacts": artifacts,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"  manifest: {len(tables)} tables, {manifest['total_rows']:,} rows")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description="Package rootfast.db into release artifacts.")
    ap.add_argument("db", type=Path, help="path to the built rootfast.db")
    ap.add_argument("out", type=Path, help="output directory for release artifacts")
    ap.add_argument("--tag", required=True, help="release tag, e.g. data-v2026.07")
    args = ap.parse_args()
    export(args.db, args.out, args.tag)


if __name__ == "__main__":
    main()
