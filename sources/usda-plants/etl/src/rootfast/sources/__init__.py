"""Per-source ingest modules.

Each module exposes:
    load(raw_dir: Path) -> Iterable[<typed records>]

Records are not yet Species; they're source-shaped. The merge step in
scripts/build_dataset.py joins them on usda_symbol.
"""
