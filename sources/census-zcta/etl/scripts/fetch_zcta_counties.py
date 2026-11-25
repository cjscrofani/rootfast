"""Download the US Census 2020 ZCTA → county relationship file.

ZCTAs (ZIP Code Tabulation Areas) are the Census Bureau's generalisation of
USPS ZIP delivery areas. The relationship file lists, for every ZCTA, each
county it overlaps and the land/water area of that overlap — which is all
we need to turn a ZIP into one or more county FIPS codes.

Source (public domain):
    https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt

Idempotent: skips the download when the file is already cached under raw/.

Usage:
    python3 scripts/fetch_zcta_counties.py [--force]
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ETL_ROOT = Path(__file__).resolve().parent.parent
RAW = ETL_ROOT / "raw"
OUT = RAW / "tab20_zcta520_county20_natl.txt"
URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/"
    "tab20_zcta520_county20_natl.txt"
)


def main() -> None:
    force = "--force" in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    if OUT.exists() and not force:
        print(f"  ✓ cached: {OUT} ({OUT.stat().st_size / 1024 / 1024:.1f} MB) — pass --force to refetch")
        return
    print(f"  Fetching {URL}")
    req = urllib.request.Request(URL, headers={"User-Agent": "rootfast-etl (+https://rootfast.org)"})
    with urllib.request.urlopen(req, timeout=120) as resp, OUT.open("wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    print(f"  ✓ wrote {OUT} ({OUT.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
