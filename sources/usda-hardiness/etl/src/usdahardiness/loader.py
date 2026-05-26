"""USDA Plant Hardiness Zones — county-level for Montana.

v1 uses a hand-curated CSV (56 rows) mapping each Montana county to its
predominant hardiness zone, transcribed from the USDA 2023 state PNG.

The county_id column uses the same PlantLocationId scheme as the USDA
PLANTS API (see data/raw/usda_plants/mt_counties.json for the canonical
list).

Upgrade path (v1.1): raster lookup against PRISM GeoTIFF, keyed by lat/lng
rather than county centroid.

Expected file:
    data/raw/hardiness/mt_county_zones.csv
Columns: county_id, county_name, predominant_zone
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd


def load(raw_dir: Path) -> dict[str, str]:
    """Return {county_id: zone}."""
    path = raw_dir / "hardiness" / "mt_county_zones.csv"
    if not path.exists():
        return {}
    df = pd.read_csv(path, dtype={"county_id": str})
    return {str(row.county_id): row.predominant_zone for row in df.itertuples(index=False)}
