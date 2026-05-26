"""Xerces Society Rocky Mountains pollinator plant list.

Source PDF must be downloaded manually (xerces.org is Cloudflare-protected):
    https://xerces.org/publications/plant-lists/native-plants-for-pollinators-and-beneficial-insects-rocky-mountains
Save as data/raw/xerces/rocky_mountains.pdf, then transcribe into:
    data/raw/xerces/rocky_mountains.yaml

YAML shape (per entry):
    - scientific_name: Penstemon strictus
      usda_symbol: PEST2
      bloom_months: [6, 7]
      pollinator_value:
        native_bees: high
        butterflies: medium
        hummingbirds: high
      host_plant_for: []

License note: Xerces content is copyrighted. v1 must include source citation
per record; before public release, confirm reuse terms with Xerces or store
only attribution-linked references rather than copying content verbatim.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class XercesEntry:
    scientific_name: str
    usda_symbol: str | None
    bloom_months: list[int] = field(default_factory=list)
    pollinator_value: dict[str, str] = field(default_factory=dict)
    host_plant_for: list[str] = field(default_factory=list)


def load(raw_dir: Path) -> Iterable[XercesEntry]:
    path = raw_dir / "xerces" / "rocky_mountains.yaml"
    if not path.exists():
        return iter(())
    with path.open() as f:
        data = yaml.safe_load(f) or []
    for entry in data:
        yield XercesEntry(**entry)
