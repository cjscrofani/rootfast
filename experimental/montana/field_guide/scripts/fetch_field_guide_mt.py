"""Crawl fieldguide.mt.gov for every Montana plant species.

The Field Guide is ASP.NET WebForms with server-side rendered HTML — no JSON
API, no AJAX. Navigation is Kingdom → Phylum → Class → Family → Species,
with each species reachable at speciesDetail.aspx?elcode={ELCODE}.

Process:
1. Walk the 12 plant phyla → families → species, collecting ELCODEs.
2. For each ELCODE, cache two responses:
   - data/raw/field_guide/species/{ELCODE}.html  — full detail page
   - data/raw/field_guide/obs_chart/{ELCODE}.html — monthly observation counts
3. Idempotent: skips files already on disk.

Threading: 12 workers, polite. The site is hosted by Montana state and is
served from a small ASP.NET pool; don't hammer it.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE = "https://fieldguide.mt.gov"
UA = "rootfast/0.0.1 (data ingest for native plant finder; mtnhp@mt.gov already contacted)"
WORKERS = 8


def _get(url: str, retries: int = 4) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(2 ** attempt)
    assert last is not None
    raise last


PHYLA = [
    "Anthophyta", "Bryophyta", "Charophyta", "Chlorophyta", "Equisetophyta",
    "Filicinophyta", "Glaucophyta", "Gnetophyta", "Hepatophyta", "Lycophyta",
    "Pinophyta", "Rhodophyta",
]

RE_CLASS  = re.compile(r"displayFamily\.aspx\?class=([A-Za-z]+)")
RE_FAMILY = re.compile(r"displaySpecies\.aspx\?family=([A-Za-z]+)")
RE_ELCODE = re.compile(r"speciesDetail\.aspx\?elcode=([A-Z0-9]+)")


def discover_elcodes() -> list[str]:
    """Walk Kingdom Plantae → all phyla → classes → families → species."""
    elcodes: set[str] = set()
    families: set[str] = set()
    classes: set[str] = set()

    for phylum in PHYLA:
        html = _get(f"{BASE}/displayClasses.aspx?phylum={phylum}")
        # Some phyla skip the Class level and link directly to families/species.
        for m in RE_CLASS.finditer(html):
            classes.add(m.group(1))
        for m in RE_FAMILY.finditer(html):
            families.add(m.group(1))
        for m in RE_ELCODE.finditer(html):
            elcodes.add(m.group(1))

    for cls in sorted(classes):
        html = _get(f"{BASE}/displayFamily.aspx?class={cls}")
        for m in RE_FAMILY.finditer(html):
            families.add(m.group(1))
        for m in RE_ELCODE.finditer(html):
            elcodes.add(m.group(1))

    for fam in sorted(families):
        html = _get(f"{BASE}/displaySpecies.aspx?family={fam}")
        for m in RE_ELCODE.finditer(html):
            elcodes.add(m.group(1))

    return sorted(elcodes)


def _fetch_one(url: str, out: Path) -> tuple[Path, bool, str | None]:
    if out.exists() and out.stat().st_size > 200:
        return out, True, None
    try:
        body = _get(url)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(body)
        return out, True, None
    except Exception as e:
        return out, False, str(e)


DATA_ROOT = Path(__file__).resolve().parent.parent  # scripts/X.py → data/


def main() -> None:
    out_root = DATA_ROOT / "raw" / "field_guide"
    out_root.mkdir(parents=True, exist_ok=True)

    cache = out_root / "elcodes.json"
    if cache.exists():
        elcodes = json.loads(cache.read_bytes())
        print(f"Reusing cached ELCODE list: {len(elcodes)}")
    else:
        print("Enumerating ELCODEs...")
        elcodes = discover_elcodes()
        cache.write_text(json.dumps(elcodes))
        print(f"Discovered {len(elcodes)} ELCODEs")

    if not elcodes:
        sys.exit("Discovered 0 ELCODEs — site layout may have changed.")

    species_dir = out_root / "species"
    obs_dir = out_root / "obs_chart"

    work: list[tuple[str, Path]] = []
    for el in elcodes:
        work.append((f"{BASE}/speciesDetail.aspx?elcode={el}", species_dir / f"{el}.html"))
        work.append((f"{BASE}/ObsChart_FS.aspx?elcode={el}", obs_dir / f"{el}.html"))

    print(f"Fetching {len(work)} pages ({len(elcodes)} species × 2)...")

    done = 0
    fails = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for _, ok, err in (f.result() for f in as_completed([ex.submit(_fetch_one, u, p) for u, p in work])):
            done += 1
            if not ok:
                fails += 1
            if done % 500 == 0:
                print(f"  {done}/{len(work)} done, {fails} fails")

    print(f"Done. {done} pages, {fails} failures.")


if __name__ == "__main__":
    main()
