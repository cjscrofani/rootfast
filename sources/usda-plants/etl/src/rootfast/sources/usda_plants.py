"""USDA PLANTS — county-level native distribution for Montana.

Source data is fetched by scripts/fetch_usda_plants_mt.py and lives at:
    data/raw/usda_plants/mt_counties.json      — 56 MT counties (PlantLocationId + name)
    data/raw/usda_plants/mt_distribution.json  — raw (plant × county × nativity) rows
                                                  including bleed from bordering states
    data/raw/usda_plants/profiles/{id}.json    — one PlantProfile per distinct plant

This loader filters bordering-state bleed by name-matching against the
canonical MT county list, then yields one PresenceRow per (plant, county).

The MapServer's `Symbol` field is misnamed — it carries the nativity status
("Native", "Introduced", "Both"). The actual USDA plant symbol comes from
the PlantProfile cache, keyed by plant_master_id.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

# Strip the <i>...</i> wrapping that USDA returns around scientific names.
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class PresenceRow:
    usda_symbol: str
    scientific_name: str
    common_name: str | None
    family: str | None
    plant_master_id: int
    county_plant_location_id: int  # MT canonical, from mt_counties.json
    county_name: str
    nativity: str  # "Native" | "Introduced" | "Both"
    rank: str | None  # "Species", "Subspecies", "Variety", etc.


# USDA records presence at multiple taxonomic ranks. We keep only ranks a
# gardener could actually plant — species and below. Genus and family rollups
# are pruned because they're "some plant in this family is here" aggregations
# that don't correspond to a specific plant a nursery would sell.
_ACTIONABLE_RANKS = frozenset({"Species", "Subspecies", "Variety", "Form"})


def _clean(s: str | None) -> str | None:
    if not s:
        return None
    return _TAG_RE.sub("", s).strip()


def load(raw_dir: Path) -> Iterable[PresenceRow]:
    # raw_dir is the etl/raw/ dir for sources/usda-plants/ — flat layout, no
    # extra `usda_plants/` namespace inside.
    counties = json.loads((raw_dir / "mt_counties.json").read_bytes())
    distribution = json.loads((raw_dir / "mt_distribution.json").read_bytes())
    profile_dir = raw_dir / "profiles"

    mt_name_to_id = {c["PlantLocationName"]: c["PlantLocationId"] for c in counties}

    profiles: dict[int, dict] = {}

    for row in distribution:
        county_name = row["country_subdivision_name"]
        if county_name not in mt_name_to_id:
            continue  # bleed from neighboring states

        pid = row["plant_master_id"]
        if pid not in profiles:
            path = profile_dir / f"{pid}.json"
            if not path.exists():
                continue
            profiles[pid] = json.loads(path.read_bytes())
        p = profiles[pid]

        symbol = p.get("Symbol")
        if not symbol:
            continue

        rank = p.get("Rank")
        if rank not in _ACTIONABLE_RANKS:
            continue

        family = None
        # Family is buried in the Ancestors list (Rank == "Family").
        for anc in p.get("Ancestors") or []:
            if anc.get("Rank") == "Family":
                family = _clean(anc.get("ScientificName"))
                break

        yield PresenceRow(
            usda_symbol=symbol,
            scientific_name=_clean(p.get("ScientificName")) or "",
            common_name=p.get("CommonName"),
            family=family,
            plant_master_id=pid,
            county_plant_location_id=mt_name_to_id[county_name],
            county_name=county_name,
            nativity=row["Symbol"],  # the misnamed field
            rank=p.get("Rank"),
        )
