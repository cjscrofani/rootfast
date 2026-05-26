"""Fetch every per-plant data tab from USDA PLANTS for the Montana taxa.

Reads existing PlantProfile cache at data/raw/usda_plants/profiles/{id}.json,
inspects the `Has*` flags, and pulls only the endpoints that have data. Each
tab response is cached as a separate file so we can re-derive consolidations
cheaply.

Output layout:
    data/raw/usda_plants/tabs/
        characteristics/{id}.json
        synonyms/{id}.json
        subordinate_taxa/{id}.json
        wildlife/{id}.json
        wetland/{id}.json
        pollinator/{id}.json
        noxious_status/{id}.json
        invasive_status/{id}.json
        legal_status/{id}.json
        ethnobotany/{id}.json
        documentation/{id}.json
        related_links/{id}.json
        classification/{id}.json   (no Has flag — always fetched)

Idempotent: re-running uses existing files. Stdlib + ThreadPoolExecutor.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

API = "https://plantsservices.sc.egov.usda.gov/api"
UA = "rootfast/0.0.1 (https://github.com/...; data ingest)"
WORKERS = 16

# (tab_dir, endpoint_template, has_flag_key_in_profile)
# has_flag = None means always fetch.
TABS: list[tuple[str, str, str | None]] = [
    ("characteristics",  "PlantCharacteristics/{id}",                  "HasCharacteristics"),
    ("synonyms",         "PlantSynonyms/{id}",                          "HasSynonyms"),
    ("subordinate_taxa", "PlantSubordinateTaxa/{id}?offset=0",          "HasSubordinateTaxa"),
    ("wildlife",         "PlantWildlife/{id}",                          "HasWildlife"),
    ("wetland",          "PlantWetland/{id}",                           "HasWetlandData"),
    ("pollinator",       "PlantPollinator/{id}",                        "HasPollinator"),
    ("noxious_status",   "PlantNoxiousStatus/{id}",                     "HasNoxiousStatuses"),
    ("invasive_status",  "PlantInvasiveStatus/{id}",                    "HasInvasiveStatuses"),
    ("legal_status",     "PlantLegalStatus/{id}",                       "HasLegalStatuses"),
    ("ethnobotany",      "PlantEthnobotany/{id}",                       "HasEthnobotany"),
    ("documentation",    "PlantDocumentation/{id}?orderBy=Author&offset=0", "HasDocumentation"),
    ("related_links",    "PlantRelatedLinks/{id}",                      "HasRelatedLinks"),
    ("classification",   "Classification/{id}",                         None),
]


def _http_get(url: str, retries: int = 5) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(2 ** attempt)
    assert last is not None
    raise last


def _plant_ids_with_profiles(profile_dir: Path) -> list[int]:
    return sorted(int(p.stem) for p in profile_dir.glob("*.json"))


def _build_work_list(
    profile_dir: Path,
    tabs_root: Path,
    plant_ids: list[int],
) -> list[tuple[int, str, str, Path]]:
    """Return (id, tab_name, url_path, out_path) for every (plant, tab) pair that
    needs fetching."""
    work: list[tuple[int, str, str, Path]] = []
    for pid in plant_ids:
        profile = json.loads((profile_dir / f"{pid}.json").read_bytes())
        for tab_dir, ep_tpl, has_key in TABS:
            out = tabs_root / tab_dir / f"{pid}.json"
            if out.exists() and out.stat().st_size > 2:
                continue
            if has_key is not None and not profile.get(has_key):
                continue
            work.append((pid, tab_dir, ep_tpl.format(id=pid), out))
    return work


def _fetch_one(item: tuple[int, str, str, Path]) -> tuple[int, str, bool, str | None]:
    pid, tab, ep, out = item
    try:
        body = _http_get(f"{API}/{ep}")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        return pid, tab, True, None
    except Exception as e:
        return pid, tab, False, str(e)


ETL_ROOT = Path(__file__).resolve().parent.parent  # scripts/X.py → etl/


def main() -> None:
    root = ETL_ROOT / "raw"
    profile_dir = root / "profiles"
    tabs_root = root / "tabs"

    if not profile_dir.exists():
        sys.exit("No profile cache. Run fetch_usda_plants_mt.py first.")

    plant_ids = _plant_ids_with_profiles(profile_dir)
    print(f"Plants with cached profiles: {len(plant_ids)}")

    work = _build_work_list(profile_dir, tabs_root, plant_ids)
    print(f"Tab fetches to perform: {len(work)}")
    if not work:
        print("Nothing to do — every gated tab is already cached.")
        return

    counts_by_tab: dict[str, dict[str, int]] = {}
    completed = 0
    failures: list[tuple[int, str, str]] = []

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for pid, tab, ok, err in (
            f.result() for f in as_completed([ex.submit(_fetch_one, w) for w in work])
        ):
            counts_by_tab.setdefault(tab, {"ok": 0, "fail": 0})
            counts_by_tab[tab]["ok" if ok else "fail"] += 1
            if not ok:
                failures.append((pid, tab, err or ""))
            completed += 1
            if completed % 500 == 0:
                print(f"  {completed}/{len(work)} done")

    print(f"\nDone. {completed} requests.")
    for tab in sorted(counts_by_tab):
        c = counts_by_tab[tab]
        print(f"  {tab:18}  ok={c['ok']:>5}  fail={c['fail']}")

    if failures:
        print(f"\n{len(failures)} failures (first 5):")
        for pid, tab, err in failures[:5]:
            print(f"  {pid} {tab}: {err[:120]}")


if __name__ == "__main__":
    main()
