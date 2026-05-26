"""Consolidate every USDA PLANTS cache file into one explorable JSON.

Reads:
    data/raw/usda_plants/mt_counties.json
    data/raw/usda_plants/mt_distribution.json
    data/raw/usda_plants/profiles/{id}.json     (PlantProfile)
    data/raw/usda_plants/tabs/<tab>/{id}.json   (every per-plant tab)

Writes:
    data/raw/usda_plants/mt_plants_full.json
        One record per USDA symbol with profile + all tab payloads inlined +
        the list of MT counties where the taxon occurs, with nativity.

    data/raw/usda_plants/mt_plants_full.summary.json
        Per-field coverage stats: how many records have each field, examples.

The output is intentionally raw — it keeps the upstream field names and shapes
so you can grep through it to decide what's worth normalizing.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

# scripts/X.py → etl/scripts → etl/
ETL_ROOT = Path(__file__).resolve().parent.parent
ROOT = ETL_ROOT / "raw"
PROFILES = ROOT / "profiles"
TABS = ROOT / "tabs"
OUT = ROOT / "mt_plants_full.json"
OUT_SUMMARY = ROOT / "mt_plants_full.summary.json"

# Limit to actionable taxonomic ranks — same filter as the loader uses.
ACTIONABLE_RANKS = frozenset({"Species", "Subspecies", "Variety", "Form"})

# Strip <i>...</i> markup that USDA wraps around scientific names.
_TAG = re.compile(r"<[^>]+>")


def _clean(s: str | None) -> str | None:
    if not s:
        return None
    return _TAG.sub("", s).strip()


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_bytes())
    except Exception as e:
        print(f"  skip {p}: {e}")
        return None


def _county_presence_by_plant_id(
    distribution: list[dict],
    mt_county_name_to_id: dict[str, int],
) -> dict[int, list[dict]]:
    """Build {plant_master_id: [{county_id, county_name, nativity}, ...]}.

    The upstream MapServer occasionally has duplicate rows for the same
    (plant, county) pair — likely a result of multiple data sources
    independently reporting the same occurrence. Dedupe per plant on
    (county_id, nativity), keeping the first nativity per county.
    """
    out: dict[int, list[dict]] = defaultdict(list)
    seen: dict[int, set[int]] = defaultdict(set)
    for row in distribution:
        name = row["country_subdivision_name"]
        if name not in mt_county_name_to_id:
            continue  # bleed from neighboring states
        cid = mt_county_name_to_id[name]
        pid = row["plant_master_id"]
        if cid in seen[pid]:
            continue
        seen[pid].add(cid)
        out[pid].append(
            {
                "county_id": cid,
                "county_name": name,
                "nativity": row["Symbol"],  # misnamed upstream
            }
        )
    return out


def _load_tabs_for(pid: int) -> dict[str, Any]:
    """Inline every cached tab payload for one plant_master_id."""
    out: dict[str, Any] = {}
    if not TABS.exists():
        return out
    for tab_dir in sorted(TABS.iterdir()):
        if not tab_dir.is_dir():
            continue
        path = tab_dir / f"{pid}.json"
        if path.exists() and path.stat().st_size > 2:
            payload = _read_json(path)
            if payload is not None:
                out[tab_dir.name] = payload
    return out


def main() -> None:
    counties = _read_json(ROOT / "mt_counties.json") or []
    distribution = _read_json(ROOT / "mt_distribution.json") or []
    mt_county_name_to_id = {c["PlantLocationName"]: c["PlantLocationId"] for c in counties}

    print(f"MT counties: {len(mt_county_name_to_id)}")
    print(f"Distribution rows: {len(distribution)}")

    presence = _county_presence_by_plant_id(distribution, mt_county_name_to_id)
    print(f"Plants with any MT presence: {len(presence)}")

    records: dict[str, dict] = {}  # keyed by usda_symbol

    skipped_rank = 0
    skipped_no_symbol = 0

    for pid, county_list in presence.items():
        profile_path = PROFILES / f"{pid}.json"
        if not profile_path.exists():
            continue
        profile = _read_json(profile_path)
        if profile is None:
            continue

        rank = profile.get("Rank")
        if rank not in ACTIONABLE_RANKS:
            skipped_rank += 1
            continue

        symbol = profile.get("Symbol")
        if not symbol:
            skipped_no_symbol += 1
            continue

        # Family from the Ancestors list.
        family = None
        for anc in profile.get("Ancestors") or []:
            if anc.get("Rank") == "Family":
                family = _clean(anc.get("ScientificName"))
                break

        rec = {
            "usda_symbol": symbol,
            "plant_master_id": pid,
            "scientific_name": _clean(profile.get("ScientificName")),
            "common_name": profile.get("CommonName"),
            "other_common_names": [n for n in (profile.get("OtherCommonNames") or []) if n],
            "family": family,
            "rank": rank,
            "group": profile.get("Group"),
            "durations": profile.get("Durations") or [],
            "growth_habits": profile.get("GrowthHabits") or [],
            "native_statuses": profile.get("NativeStatuses") or [],
            "synonym_symbol": profile.get("SynonymSymbol"),
            "accepted_symbol": profile.get("AcceptedSymbol"),
            "plant_notes": profile.get("PlantNotes") or {},
            "has_flags": {
                k: v for k, v in profile.items() if k.startswith("Has") and isinstance(v, bool)
            },
            "mt_counties": sorted(county_list, key=lambda c: c["county_name"]),
            "tabs": _load_tabs_for(pid),
        }

        # If a record already exists for this symbol (e.g. synonym collisions
        # in the cache), prefer the one with more county presence.
        if symbol in records:
            if len(records[symbol]["mt_counties"]) >= len(rec["mt_counties"]):
                continue
        records[symbol] = rec

    OUT.write_text(json.dumps(records, indent=2, sort_keys=True))
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"\nWrote {len(records)} consolidated records → {OUT} ({size_mb:.1f} MB)")
    print(f"  skipped (non-actionable rank): {skipped_rank}")
    print(f"  skipped (no symbol):           {skipped_no_symbol}")

    # ---- Coverage summary -------------------------------------------------
    tab_coverage: Counter[str] = Counter()
    flag_coverage: Counter[str] = Counter()
    rank_counts: Counter[str] = Counter()
    nativity_counts: Counter[str] = Counter()
    duration_counts: Counter[str] = Counter()
    growth_habit_counts: Counter[str] = Counter()
    family_counts: Counter[str] = Counter()
    counties_per_plant: list[int] = []

    for rec in records.values():
        rank_counts[rec["rank"]] += 1
        family_counts[rec["family"] or "(none)"] += 1
        for d in rec["durations"]:
            duration_counts[d] += 1
        for g in rec["growth_habits"]:
            growth_habit_counts[g] += 1
        for ns in rec["native_statuses"]:
            nativity_counts[f"{ns.get('Region')}={ns.get('Type')}"] += 1
        for k, v in rec["has_flags"].items():
            if v:
                flag_coverage[k] += 1
        for tab_name in rec["tabs"]:
            tab_coverage[tab_name] += 1
        counties_per_plant.append(len(rec["mt_counties"]))

    summary = {
        "plant_count": len(records),
        "rank_counts": dict(rank_counts),
        "tab_coverage": dict(tab_coverage),
        "has_flag_coverage": dict(flag_coverage),
        "duration_counts": dict(duration_counts),
        "growth_habit_counts": dict(growth_habit_counts),
        "nativity_region_type_counts": dict(nativity_counts),
        "top_20_families": dict(family_counts.most_common(20)),
        "mt_counties_per_plant": {
            "min": min(counties_per_plant, default=0),
            "max": max(counties_per_plant, default=0),
            "median": sorted(counties_per_plant)[len(counties_per_plant) // 2]
            if counties_per_plant
            else 0,
            "histogram": dict(Counter(counties_per_plant)),
        },
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2, sort_keys=True))
    print(f"Wrote summary → {OUT_SUMMARY}")

    # ---- Human-readable summary to stdout ---------------------------------
    print("\n=== Coverage ===")
    print(f"  records:               {len(records)}")
    print(f"  ranks:                 {dict(rank_counts)}")
    print(f"  MT counties / plant:   min={summary['mt_counties_per_plant']['min']}  "
          f"median={summary['mt_counties_per_plant']['median']}  "
          f"max={summary['mt_counties_per_plant']['max']}")
    print("\n  Tabs with data:")
    for tab in sorted(tab_coverage, key=tab_coverage.get, reverse=True):
        pct = 100.0 * tab_coverage[tab] / max(len(records), 1)
        print(f"    {tab:18}  {tab_coverage[tab]:>4}  ({pct:>5.1f}%)")
    print("\n  Has* flags (% of plants):")
    for f in sorted(flag_coverage, key=flag_coverage.get, reverse=True):
        pct = 100.0 * flag_coverage[f] / max(len(records), 1)
        print(f"    {f:25}  {flag_coverage[f]:>4}  ({pct:>5.1f}%)")


if __name__ == "__main__":
    main()
