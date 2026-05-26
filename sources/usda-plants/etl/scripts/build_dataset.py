"""Build the rootfast dataset.

Usage:
    python scripts/build_dataset.py [--raw RAW] [--out OUT]

Defaults to `raw/` and `processed/` inside the data subproject root.

Outputs:
    processed/plants.json    — {usda_symbol: Species}
    processed/counties.json  — {county_id: CountyPresence}
    processed/manifest.json  — DatasetManifest
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# scripts/X.py → etl/scripts → etl/  (lets scripts run from any cwd)
ETL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ETL_ROOT / "src"))

UTC = timezone.utc

from rootfast import __version__  # noqa: E402
from rootfast.merge import build  # noqa: E402
from rootfast.schema import DatasetManifest  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=ETL_ROOT / "raw")
    parser.add_argument("--out", type=Path, default=ETL_ROOT / "processed")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    species, counties = build(args.raw)

    plants_json = {sym: sp.model_dump(mode="json") for sym, sp in species.items()}
    counties_json = {fips: cp.model_dump(mode="json") for fips, cp in counties.items()}

    manifest = DatasetManifest(
        version=__version__,
        build_date=datetime.now(UTC).isoformat(),
        states_covered=["MT"],
        species_count=len(species),
        county_count=len(counties),
        source_versions={
            "usda_plants": "pending",
            "hardiness": "2023",
            "xerces_rocky_mountains": "pending",
            "msu_extension": "MT201304AG",
            "mt_field_guide": "pending",
        },
    )

    (args.out / "plants.json").write_text(json.dumps(plants_json, indent=2, sort_keys=True))
    (args.out / "counties.json").write_text(json.dumps(counties_json, indent=2, sort_keys=True))
    (args.out / "manifest.json").write_text(json.dumps(manifest.model_dump(mode="json"), indent=2))

    print(f"Wrote {len(species)} species and {len(counties)} counties to {args.out}")


if __name__ == "__main__":
    main()
