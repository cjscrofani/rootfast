"""Filesystem layout for sources/usda-plants/etl/.

All paths resolve relative to this file so behavior is independent of
caller cwd.

Layout:
    sources/usda-plants/etl/
    ├── raw/         upstream USDA caches (gitignored)
    ├── processed/   built artifacts: JSON now, SQLite once phase 1 lands
    ├── scripts/     CLI entry points
    └── src/rootfast/

The Python package keeps the name `rootfast` for v0; renaming it to
something USDA-specific is a non-urgent follow-up that touches every import.
"""

from __future__ import annotations

from pathlib import Path

# etl/src/rootfast/paths.py → parents[2] = etl/
ETL_ROOT: Path = Path(__file__).resolve().parents[2]

RAW: Path = ETL_ROOT / "raw"
PROCESSED: Path = ETL_ROOT / "processed"

# Repo root for cross-source peeks (rarely needed; only ad-hoc tools should use).
REPO_ROOT: Path = ETL_ROOT.parents[2]  # sources/usda-plants/etl → repo root
