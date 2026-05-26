"""Build Species + CountyPresence records from USDA PLANTS data only.

Scope: this is the USDA PLANTS ingestion pipeline. It feeds the Rootfast
API's unified D1 alongside other source pipelines (sources/usda-hardiness/,
and eventually iNaturalist / GBIF / Wikidata). Hardiness and MT-specific
sources live elsewhere.

Once we cut over to SQLite output (phase 1), this merge step will be replaced
by a schema-driven SQLite emitter. For now it still produces JSON, used to
validate the upstream USDA cache end-to-end against the existing pydantic
schema.
"""

from __future__ import annotations

from pathlib import Path

from .schema import CountyPresence, Species
from .sources import usda_plants


def build(raw_dir: Path) -> tuple[dict[str, Species], dict[str, CountyPresence]]:
    """Return (species_by_symbol, county_presence_by_id) from USDA PLANTS data."""
    presence_rows = list(usda_plants.load(raw_dir))

    counties_by_id: dict[str, dict] = {}
    species_meta: dict[str, dict] = {}

    for row in presence_rows:
        # Keep native + introduced — filtering is a query-time concern. The
        # API exposes nativity so consumers can decide.
        cid = str(row.county_plant_location_id)
        bucket = counties_by_id.setdefault(
            cid,
            {"name": row.county_name, "symbols": set()},
        )
        bucket["symbols"].add(row.usda_symbol)

        species_meta.setdefault(
            row.usda_symbol,
            {
                "scientific_name": row.scientific_name,
                "common_name": row.common_name,
                "family": row.family,
            },
        )

    counties: dict[str, CountyPresence] = {}
    for cid, bucket in counties_by_id.items():
        counties[cid] = CountyPresence(
            county_id=cid,
            state_abbr="MT",  # TODO: derive from the row when we go nationwide
            county_name=bucket["name"],
            usda_symbols=sorted(bucket["symbols"]),
            predominant_hardiness_zone=None,  # owned by sources/usda-hardiness/
        )

    species: dict[str, Species] = {}
    for symbol, meta in species_meta.items():
        species[symbol] = Species(
            usda_symbol=symbol,
            scientific_name=meta["scientific_name"],
            common_names=[meta["common_name"]] if meta.get("common_name") else [],
            family=meta.get("family"),
        )

    return species, counties
