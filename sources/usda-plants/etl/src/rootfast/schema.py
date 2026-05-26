"""Pydantic models for the rootfast joined dataset.

The output of the ETL is two JSON files:

- plants.json    — keyed by USDA symbol, contains species attributes (Species)
- counties.json  — keyed by 5-digit FIPS, contains list of USDA symbols (CountyPresence)

Every joined attribute in Species is wrapped in a Sourced[T] envelope so the
downstream API can return provenance and confidence per field.
"""

from __future__ import annotations

from enum import Enum
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Confidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNKNOWN = "unknown"


class Sourced(BaseModel, Generic[T]):
    """A value paired with where it came from and how much to trust it."""

    value: T
    source: str = Field(description="Short source key, e.g. 'usda_plants', 'xerces_rm_2018'")
    confidence: Confidence = Confidence.UNKNOWN
    note: str | None = None


class Sun(str, Enum):
    FULL_SUN = "full_sun"
    PART_SUN = "part_sun"
    PART_SHADE = "part_shade"
    FULL_SHADE = "full_shade"


class Moisture(str, Enum):
    DRY = "dry"
    MEDIUM_DRY = "medium_dry"
    MEDIUM = "medium"
    MEDIUM_WET = "medium_wet"
    WET = "wet"


class PollinatorGroup(str, Enum):
    NATIVE_BEES = "native_bees"
    SPECIALIST_BEES = "specialist_bees"
    BUTTERFLIES = "butterflies"
    MOTHS = "moths"
    HUMMINGBIRDS = "hummingbirds"
    BENEFICIAL_WASPS = "beneficial_wasps"


class BloomPeriod(BaseModel):
    """Months as 1–12. Peak optional, may match start or end."""

    start_month: int = Field(ge=1, le=12)
    peak_month: int | None = Field(default=None, ge=1, le=12)
    end_month: int = Field(ge=1, le=12)


class Species(BaseModel):
    """One species record. usda_symbol is the primary key."""

    usda_symbol: str = Field(description="USDA PLANTS symbol, e.g. 'ANPA'")
    scientific_name: str
    common_names: list[str] = Field(default_factory=list)
    family: str | None = None

    # All the joined fields are Sourced so provenance survives serialization.
    bloom: Sourced[BloomPeriod] | None = None
    bloom_color: Sourced[list[str]] | None = None
    mature_height_cm: Sourced[tuple[int, int]] | None = None  # (min, max)
    sun: Sourced[list[Sun]] | None = None
    moisture: Sourced[list[Moisture]] | None = None
    soil_notes: Sourced[str] | None = None
    habitat_notes: Sourced[str] | None = None  # narrative ecological/community context

    pollinator_value: dict[PollinatorGroup, Sourced[Literal["high", "medium", "low"]]] = Field(
        default_factory=dict,
    )
    host_caterpillar_count: Sourced[int] | None = None  # Tallamy-style
    bird_value_notes: Sourced[str] | None = None

    hardiness_zones: Sourced[list[str]] | None = None  # e.g. ['3a','3b','4a',...]
    commercial_availability: Sourced[Literal["common", "occasional", "rare", "unknown"]] | None = (
        None
    )
    caveats: list[Sourced[str]] = Field(default_factory=list)


class CountyPresence(BaseModel):
    """Plants recorded as present in a county.

    v1: `county_id` is the USDA PlantLocationId as a string (the only ID we
    have from the upstream MapServer that round-trips correctly).
    v1.1 plan: add `fips` populated from a TIGER/Line reference table.
    """

    county_id: str
    state_abbr: str
    county_name: str
    usda_symbols: list[str]
    predominant_hardiness_zone: str | None = None
    fips: str | None = None  # filled in v1.1 from a reference table


class DatasetManifest(BaseModel):
    """Top-level manifest describing the release."""

    version: str
    build_date: str  # ISO 8601
    states_covered: list[str]
    species_count: int
    county_count: int
    source_versions: dict[str, str]  # e.g. {'usda_plants': '2024-Q3', ...}
