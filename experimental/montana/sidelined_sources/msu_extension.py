"""MSU Extension — "Native Plants for Montana's Home Gardens" (MT201304AG).

Source PDF must be downloaded manually (extension-store.montana.edu is
Cloudflare-protected):
    https://extension-store.montana.edu/montguides/native-plants-for-montanas-home-gardens
Save as data/raw/msu_extension/native_plants.pdf, then transcribe into:
    data/raw/msu_extension/native_plants.yaml

YAML shape (per entry):
    - scientific_name: Geranium viscosissimum
      usda_symbol: GEVI2
      common_name: Sticky geranium
      bloom_months: [5, 6, 7]
      bloom_color: [pink, purple]
      height_cm: [30, 60]
      sun: [full_sun, part_sun]
      moisture: [dry, medium]
      hardiness_zones: ['3a','3b','4a','4b','5a','5b']
      pollinator_notes: "Bees, butterflies."
      caveats: []

License: MSU Extension publications are generally reuse-friendly with citation;
confirm before public release.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class MSUEntry:
    scientific_name: str
    usda_symbol: str | None = None
    common_name: str | None = None
    bloom_months: list[int] = field(default_factory=list)
    bloom_color: list[str] = field(default_factory=list)
    height_cm: tuple[int, int] | None = None
    sun: list[str] = field(default_factory=list)
    moisture: list[str] = field(default_factory=list)
    hardiness_zones: list[str] = field(default_factory=list)
    pollinator_notes: str | None = None
    caveats: list[str] = field(default_factory=list)


def load(raw_dir: Path) -> Iterable[MSUEntry]:
    path = raw_dir / "msu_extension" / "native_plants.yaml"
    if not path.exists():
        return iter(())
    with path.open() as f:
        data = yaml.safe_load(f) or []
    for entry in data:
        if "height_cm" in entry and isinstance(entry["height_cm"], list):
            entry["height_cm"] = tuple(entry["height_cm"])
        yield MSUEntry(**entry)
