"""Montana Field Guide (fieldguide.mt.gov) — habitat narrative + phenology.

Raw HTML is scraped by scripts/fetch_field_guide_mt.py and parsed by
scripts/consolidate_field_guide.py into:
    data/raw/field_guide/mt_field_guide_full.json

This loader reads that file and yields one FieldGuideEntry per record that
has both a USDA crosswalk and useful content. The merge step joins on
usda_symbol.

The Field Guide is a Montana Natural Heritage Program publication — public
domain (state of Montana). Attribution courtesy.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

@dataclass
class FieldGuideEntry:
    elcode: str
    scientific_name: str | None
    common_name: str | None
    usda_symbol: str | None
    general: str | None = None
    habitat: str | None = None
    distribution: str | None = None
    monthly_obs: dict[str, int] = field(default_factory=dict)
    citations: list[str] = field(default_factory=list)


def load(raw_dir: Path) -> Iterable[FieldGuideEntry]:
    """Yield Field Guide entries that crosswalk to a USDA symbol."""
    path = raw_dir / "field_guide" / "mt_field_guide_full.json"
    if not path.exists():
        return iter(())
    data = json.loads(path.read_bytes())
    for elc, rec in data.items():
        # Skip records without a USDA join key — we can't merge them.
        if not rec.get("usda_symbol"):
            continue
        yield FieldGuideEntry(
            elcode=elc,
            scientific_name=rec.get("scientific_name"),
            common_name=rec.get("common_name"),
            usda_symbol=rec["usda_symbol"],
            general=rec.get("general"),
            habitat=rec.get("habitat"),
            distribution=rec.get("distribution"),
            monthly_obs=rec.get("monthly_obs") or {},
            citations=rec.get("citations") or [],
        )


def observation_peak_month(monthly: dict[str, int]) -> int | None:
    """Month (1-12) with the most observations. None if no data.

    This is the *visibility* peak, which for many plants correlates with
    bloom / fruit / leaf-out. It's a noisy proxy — for a wind-pollinated
    grass it'll be peak growing season; for a showy forb it'll be bloom.
    """
    months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    counts = [(i + 1, monthly.get(m, 0)) for i, m in enumerate(months)]
    counts = [c for c in counts if c[1] > 0]
    if not counts:
        return None
    return max(counts, key=lambda c: c[1])[0]
