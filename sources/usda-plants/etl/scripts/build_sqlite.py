"""Build the USDA Plants source's SQLite chunk for the Rootfast API.

Reads every cached USDA artifact + the GBIF match cache, joins them, and
writes a fresh SQLite file at processed/usda_plants.db conforming to the
Rootfast schema at api/schema/001_initial.sql.

This is the SOURCE-LEVEL chunk. The API's merge step (api/scripts/build.py)
will take this + sibling source chunks (usda-hardiness, future sources) and
merge them into the unified D1.

Reads:
    raw/profiles/{plant_master_id}.json      USDA PlantProfile per plant
    raw/tabs/<tab>/{plant_master_id}.json    Per-tab payloads
    raw/mt_distribution.json                 plant × county × nativity rows
    raw/mt_counties.json                     MT counties with PlantLocationIds
    raw/gbif_matches.json                    USDA symbol → GBIF backbone match
    ../../usda-hardiness/etl/raw/            County FIPS reference (MT proof only;
                                              when nationwide we'll fetch counties
                                              into raw/counties.json ourselves)

Writes:
    processed/usda_plants.db
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

# scripts/X.py → etl/scripts → etl/
ETL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]

RAW = ETL_ROOT / "raw"
PROCESSED = ETL_ROOT / "processed"
OUT = PROCESSED / "usda_plants.db"

SCHEMA_DIR = REPO_ROOT / "api" / "schema"
HARDINESS_CENTROIDS = REPO_ROOT / "sources" / "usda-hardiness" / "etl" / "raw" / "mt_county_centroids.json"

_TAG = re.compile(r"<[^>]+>")
_ACTIONABLE_RANKS = frozenset({"Species", "Subspecies", "Variety", "Form"})


# ---- USDA Characteristics → schema column mapping ------------------------
#
# USDA's PlantCharacteristic API returns rows like
#   {PlantCharacteristicName: "Drought Tolerance",
#    PlantCharacteristicValue: "High",
#    PlantCharacteristicCategory: "Growth Requirements"}
#
# This table maps each USDA name to (column_name_in_schema, converter_fn).
# Converters normalize values for the column types. Unmapped names are
# silently ignored — log the surprise at the end.

def _b(v: str | None) -> int | None:
    if v is None or v == "":
        return None
    if v.lower() in ("yes", "true", "1"):
        return 1
    if v.lower() in ("no", "false", "0"):
        return 0
    return None


def _s(v: str | None) -> str | None:
    return v if v not in (None, "") else None


def _f(v: str | None) -> float | None:
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v: str | None) -> int | None:
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


_CHAR_MAP: dict[str, tuple[str, callable]] = {
    # Morphology / Physiology
    "Active Growth Period":              ("active_growth_period",       _s),
    "C:N Ratio":                          ("c_n_ratio",                  _s),
    "Bloat":                              ("bloat",                      _s),
    "Coppice Potential":                  ("coppice_potential",          _b),
    "Fall Conspicuous":                   ("fall_conspicuous",           _b),
    "Fire Resistant":                     ("fire_resistant",             _b),
    "Flower Color":                       ("flower_color",               _s),
    "Flower Conspicuous":                 ("flower_conspicuous",         _b),
    "Foliage Color":                      ("foliage_color",              _s),
    "Foliage Porosity Summer":            ("foliage_porosity_summer",    _s),
    "Foliage Porosity Winter":            ("foliage_porosity_winter",    _s),
    "Foliage Texture":                    ("foliage_texture",            _s),
    "Fruit/Seed Color":                   ("fruit_color",                _s),
    "Fruit/Seed Conspicuous":             ("fruit_conspicuous",          _b),
    "Growth Form":                        ("growth_form",                _s),
    "Growth Rate":                        ("growth_rate",                _s),
    "Height at 20 Years, Maximum (feet)": ("height_at_20_years_max_ft",  _f),
    "Height, Mature (feet)":              ("height_mature_ft",           _f),
    "Known Allelopath":                   ("known_allelopath",           _b),
    "Leaf Retention":                     ("leaf_retention",             _b),
    "Lifespan":                           ("lifespan",                   _s),
    "Low Growing Grass":                  ("low_growing_grass",          _b),
    "Nitrogen Fixation":                  ("nitrogen_fixation",          _s),
    "Resprout Ability":                   ("resprout_ability",           _b),
    "Shape and Orientation":              ("shape_and_orientation",      _s),
    "Toxicity":                           ("toxicity",                   _s),
    # Growth Requirements
    "Adapted to Coarse Textured Soils":   ("adapted_to_coarse_textured_soils", _b),
    "Adapted to Medium Textured Soils":   ("adapted_to_medium_textured_soils", _b),
    "Adapted to Fine Textured Soils":     ("adapted_to_fine_textured_soils",   _b),
    "Anaerobic Tolerance":                ("anaerobic_tolerance",        _s),
    "CaCO3 Tolerance":                    ("caco3_tolerance",            _s),
    "Cold Stratification Required":       ("cold_stratification_required", _b),
    "Drought Tolerance":                  ("drought_tolerance",          _s),
    "Fertility Requirement":              ("fertility_requirement",      _s),
    "Fire Tolerance":                     ("fire_tolerance",             _s),
    "Frost Free Days, Minimum":           ("frost_free_days_min",        _i),
    "Hedge Tolerance":                    ("hedge_tolerance",            _s),
    "Moisture Use":                       ("moisture_use",               _s),
    "pH (Minimum)":                       ("ph_min",                     _f),
    "pH (Maximum)":                       ("ph_max",                     _f),
    "pH, Minimum":                        ("ph_min",                     _f),
    "pH, Maximum":                        ("ph_max",                     _f),
    "Planting Density per Acre, Minimum": ("planting_density_min_per_acre", _i),
    "Planting Density per Acre, Maximum": ("planting_density_max_per_acre", _i),
    "Precipitation, Minimum":             ("precipitation_min_in",       _f),
    "Precipitation, Maximum":             ("precipitation_max_in",       _f),
    "Root Depth, Minimum (inches)":       ("root_depth_min_in",          _i),
    "Salinity Tolerance":                 ("salinity_tolerance",         _s),
    "Shade Tolerance":                    ("shade_tolerance",            _s),
    "Temperature, Minimum (°F)":          ("temperature_min_f",          _f),
    # Reproduction
    "Bloom Period":                       ("bloom_period",               _s),
    "Commercial Availability":            ("commercial_availability",    _s),
    "Fruit/Seed Abundance":               ("fruit_seed_abundance",       _s),
    "Fruit/Seed Period Begin":            ("fruit_seed_period_begin",    _s),
    "Fruit/Seed Period End":              ("fruit_seed_period_end",      _s),
    "Fruit/Seed Persistence":             ("fruit_seed_persistence",     _b),
    "Propagated by Bare Root":            ("propagated_by_bare_root",    _b),
    "Propagated by Bulb":                 ("propagated_by_bulb",         _b),
    "Propagated by Container":            ("propagated_by_container",    _b),
    "Propagated by Corm":                 ("propagated_by_corm",         _b),
    "Propagated by Cuttings":             ("propagated_by_cuttings",     _b),
    "Propagated by Seed":                 ("propagated_by_seed",         _b),
    "Propagated by Sod":                  ("propagated_by_sod",          _b),
    "Propagated by Sprigs":               ("propagated_by_sprigs",       _b),
    "Propagated by Tubers":               ("propagated_by_tubers",       _b),
    "Seed per Pound":                     ("seed_per_pound",             _i),
    "Seed Spread Rate":                   ("seed_spread_rate",           _s),
    "Seedling Vigor":                     ("seedling_vigor",             _s),
    "Small Grain":                        ("small_grain",                _b),
    "Vegetative Spread Rate":             ("vegetative_spread_rate",     _s),
    # Suitability / Use
    "Berry/Nut/Seed Product":             ("berry_nut_seed_product",     _b),
    "Christmas Tree Product":             ("christmas_tree_product",     _b),
    "Fodder Product":                     ("fodder_product",             _b),
    "Fuelwood Product":                   ("fuelwood_product",           _s),
    "Lumber Product":                     ("lumber_product",             _b),
    "Naval Store Product":                ("naval_store_product",        _b),
    "Nursery Stock Product":              ("nursery_stock_product",      _b),
    "Palatable Browse Animal":            ("palatable_browse_animal",    _s),
    "Palatable Graze Animal":             ("palatable_graze_animal",     _s),
    "Palatable Human":                    ("palatable_human",            _b),
    "Post Product":                       ("post_product",               _b),
    "Protein Potential":                  ("protein_potential",          _s),
    "Pulpwood Product":                   ("pulpwood_product",           _b),
    "Veneer Product":                     ("veneer_product",             _b),
}


def _clean(s: str | None) -> str | None:
    if not s:
        return None
    return _TAG.sub("", s).strip() or None


def _binomial(sci: str | None) -> str | None:
    """Strip authority + HTML, return the first two name tokens preserving case.

    USDA returns '<i>Pinus ponderosa</i> Lawson & C. Lawson' →
    we return 'Pinus ponderosa'. For varieties / subspecies, we also keep the
    rank marker and epithet: 'Pinus ponderosa var. scopulorum'.
    """
    cleaned = _clean(sci)
    if not cleaned:
        return None
    parts = cleaned.split()
    if len(parts) < 2:
        return None
    out = f"{parts[0]} {parts[1]}"
    # Preserve subspecies/variety/form rank if present.
    for i in range(2, len(parts) - 1):
        marker = parts[i].rstrip(".")
        if marker in ("ssp", "subsp", "var", "f"):
            out += f" {parts[i]} {parts[i + 1]}"
            break
    return out


def _genus_of(name: str | None) -> str | None:
    if not name:
        return None
    parts = _clean(name).split()
    return parts[0] if parts else None


def _family_from_ancestors(profile: dict) -> str | None:
    for anc in profile.get("Ancestors") or []:
        if anc.get("Rank") == "Family":
            return _clean(anc.get("ScientificName"))
    return None


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---- DB lifecycle --------------------------------------------------------

def open_db() -> sqlite3.Connection:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()
    db = sqlite3.connect(OUT)
    # Autocommit — we manage transactions explicitly with BEGIN/COMMIT.
    db.isolation_level = None
    db.execute("PRAGMA foreign_keys = ON")
    # Apply migrations in numerical order so this stays in sync with D1.
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        db.executescript(migration.read_text())
    return db


# ---- Reference seeds -----------------------------------------------------

# USDA's coarse region taxonomy used in NativeStatuses (PlantProfile).
_REGIONS = [
    ("AK", "Alaska", None),
    ("CAN", "Canada", None),
    ("GL", "Greenland", None),
    ("HI", "Hawaii", None),
    ("L48", "Lower 48 States", None),
    ("NA", "North America", None),
    ("NAV", "Navassa Island", None),
    ("PB", "Pacific Basin (except Hawaii)", None),
    ("PR", "Puerto Rico", None),
    ("SPM", "St. Pierre and Miquelon", None),
    ("VI", "U.S. Virgin Islands", None),
]


def seed_regions(db: sqlite3.Connection) -> None:
    db.executemany(
        "INSERT INTO regions (code, name, parent_code) VALUES (?, ?, ?)",
        _REGIONS,
    )


def seed_states(db: sqlite3.Connection) -> int:
    """Seed every state/territory present in raw/states.json (US scope)."""
    states_path = RAW / "states.json"
    if not states_path.exists():
        print(f"WARNING: {states_path} missing — falling back to MT-only seed")
        db.execute(
            "INSERT INTO states (state_code, state_name, state_fips, country, usda_plant_location_id) "
            "VALUES (?, ?, ?, ?, ?)",
            ("MT", "Montana", "30", "US", 3318),
        )
        return 1
    states = json.loads(states_path.read_bytes())
    db.executemany(
        "INSERT INTO states (state_code, state_name, state_fips, country, usda_plant_location_id) "
        "VALUES (?, ?, ?, ?, ?)",
        [(s["state_code"], s["state_name"], s["state_fips"], s["country"],
          s["usda_plant_location_id"]) for s in states],
    )
    return len(states)


def seed_counties(db: sqlite3.Connection) -> int:
    """Seed every US county from raw/counties.json."""
    counties_path = RAW / "counties.json"
    if not counties_path.exists():
        # Backwards-compat: try the MT-only hardiness centroids if counties.json is absent.
        if not HARDINESS_CENTROIDS.exists():
            print(f"WARNING: {counties_path} missing and no MT centroids — counties empty.")
            return 0
        print(f"WARNING: {counties_path} missing — falling back to MT centroids")
        centroids = json.loads(HARDINESS_CENTROIDS.read_bytes())
        rows = [
            (c["code"], c["county_name"], "MT", c["plant_location_id"], c["lat"], c["lon"])
            for c in centroids
        ]
        db.executemany(
            "INSERT INTO counties (county_fips, county_name, state_code, usda_plant_location_id, centroid_lat, centroid_lon) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        return len(rows)

    counties = json.loads(counties_path.read_bytes())
    # Drop counties whose state isn't in the states table (FK enforcement).
    known_states = {row[0] for row in db.execute("SELECT state_code FROM states").fetchall()}
    skipped_unknown_state: dict[str, int] = {}
    rows: list[tuple] = []
    for c in counties:
        sc = c["state_code"]
        if sc not in known_states:
            skipped_unknown_state[sc] = skipped_unknown_state.get(sc, 0) + 1
            continue
        rows.append((c["county_fips"], c["county_name"], sc,
                     c["usda_plant_location_id"], c["centroid_lat"], c["centroid_lon"]))
    if skipped_unknown_state:
        for sc, n in sorted(skipped_unknown_state.items()):
            print(f"  note: {n} counties skipped — state {sc} not in states table")
    # INSERT OR IGNORE: counties.json can carry duplicate FIPS in a couple of
    # places (CT planning regions overlap with old county FIPS; WI has a
    # misassigned row). Keep the first; log the skipped ones.
    before = db.execute("SELECT COUNT(*) FROM counties").fetchone()[0]
    db.executemany(
        "INSERT OR IGNORE INTO counties (county_fips, county_name, state_code, usda_plant_location_id, centroid_lat, centroid_lon) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    after = db.execute("SELECT COUNT(*) FROM counties").fetchone()[0]
    inserted = after - before
    if inserted < len(rows):
        print(f"  note: {len(rows) - inserted} county rows ignored due to FIPS dupes")
    return inserted


# ---- Plant insert --------------------------------------------------------

def load_gbif_matches() -> dict[str, dict]:
    path = RAW / "gbif_matches.json"
    if not path.exists():
        return {}
    return json.loads(path.read_bytes())


def load_inat_photos() -> dict[str, dict]:
    path = RAW / "inat_photos.json"
    if not path.exists():
        return {}
    return json.loads(path.read_bytes())


def insert_plants(db: sqlite3.Connection, gbif: dict[str, dict], photos: dict[str, dict] | None = None) -> dict[str, int]:
    """Insert every cached USDA plant. Returns {usda_symbol: row_id}."""
    photos = photos or {}
    profile_dir = RAW / "profiles"
    if not profile_dir.exists():
        sys.exit("Missing raw/profiles/ — run fetch_usda_plants_mt.py first.")

    # Build a parent-species photo index: species binomial → photo record.
    # Used when a subspecies/variety has no direct iNat match — we fall back
    # to the parent species' photo. iNat is the source of truth on whether
    # it tracks a sub-rank; when it doesn't, the species photo is the right
    # visual proxy (same plant, taxonomic detail aside).
    species_photos: dict[str, dict] = {}
    for ph_rec in photos.values():
        if ph_rec.get("match_status") != "OK":
            continue
        q = ph_rec.get("query_name") or ""
        toks = q.split()
        if len(toks) >= 2:
            key = f"{toks[0]} {toks[1]}".lower()
            species_photos.setdefault(key, ph_rec)

    symbol_to_id: dict[str, int] = {}
    skipped_rank = 0
    skipped_no_symbol = 0
    inserted = 0
    photos_direct = 0
    photos_via_parent = 0
    fetched_at = _now_iso()
    source_version = f"usda-plants-mt-{fetched_at[:10]}"

    _RANK_MARKERS = {"ssp", "subsp", "var", "f"}

    def resolve_photo(ph: dict, query_name: str | None) -> tuple[dict, bool]:
        """Return (photo_record, via_parent_flag). If ph is OK, returns it
        unchanged. Otherwise tries parent-species fallback for sub-rank taxa."""
        if ph.get("match_status") == "OK":
            return ph, False
        q = query_name or ph.get("query_name") or ""
        toks = q.split()
        # Sub-rank if there's a rank marker after the binomial.
        if len(toks) < 4:
            return ph, False
        if toks[2].rstrip(".") not in _RANK_MARKERS:
            return ph, False
        species_key = f"{toks[0]} {toks[1]}".lower()
        parent = species_photos.get(species_key)
        if not parent:
            return ph, False
        return parent, True

    db.execute("BEGIN")
    for path in sorted(profile_dir.glob("*.json")):
        try:
            p = json.loads(path.read_bytes())
        except Exception:
            continue
        symbol = p.get("Symbol")
        if not symbol:
            skipped_no_symbol += 1
            continue
        rank = p.get("Rank")
        # Only insert actionable ranks. Genus/Family-level entries from USDA
        # aren't queryable plants for our purposes.
        if rank not in _ACTIONABLE_RANKS:
            skipped_rank += 1
            continue

        sci = _clean(p.get("ScientificName"))
        canonical = _binomial(p.get("ScientificName"))
        common = p.get("CommonName")
        family = _family_from_ancestors(p)
        genus = _genus_of(canonical) if canonical else None
        group = p.get("Group")
        usda_plant_id = p.get("Id")

        # GBIF columns (NULL if no match)
        g = gbif.get(symbol, {})
        match_type = g.get("gbif_match_type")
        if match_type and match_type not in ("EXACT", "FUZZY", "HIGHERRANK", "NONE"):
            match_type = None
        match_status = g.get("gbif_match_status")
        # Schema CHECK only allows ACCEPTED/SYNONYM/DOUBTFUL — coalesce
        # HETEROTYPIC_SYNONYM etc. to nearest fit.
        if match_status and match_status not in ("ACCEPTED", "SYNONYM", "DOUBTFUL"):
            if "SYNONYM" in match_status:
                match_status = "SYNONYM"
            else:
                match_status = None

        # Photo (iNaturalist), with parent-species fallback for sub-rank taxa.
        ph_raw = photos.get(symbol) or {}
        ph, via_parent = resolve_photo(ph_raw, canonical)
        photo_has_data = ph.get("match_status") == "OK"
        if photo_has_data:
            if via_parent:
                photos_via_parent += 1
            else:
                photos_direct += 1
        cur = db.execute(
            """INSERT INTO plants (
                 usda_symbol, usda_plant_id,
                 gbif_taxon_key, gbif_canonical_name,
                 gbif_match_type, gbif_match_status, gbif_match_confidence,
                 scientific_name, scientific_name_canonical, common_name,
                 family, genus, taxonomic_group, rank,
                 source_version, fetched_at,
                 photo_source, photo_source_id, photo_taxon_id,
                 photo_url, photo_thumb_url, photo_license, photo_attribution
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                symbol, usda_plant_id,
                g.get("gbif_taxon_key"), g.get("gbif_canonical_name"),
                match_type, match_status,
                max(0, min(100, g["gbif_match_confidence"])) if isinstance(g.get("gbif_match_confidence"), (int, float)) else None,
                sci, canonical, common,
                family, genus, group, rank,
                source_version, fetched_at,
                "inaturalist" if photo_has_data else None,
                ph.get("photo_id")        if photo_has_data else None,
                ph.get("inat_taxon_id")   if photo_has_data else None,
                ph.get("url_medium")      if photo_has_data else None,
                ph.get("url_square")      if photo_has_data else None,
                ph.get("license")         if photo_has_data else None,
                ph.get("attribution")     if photo_has_data else None,
            ),
        )
        symbol_to_id[symbol] = cur.lastrowid
        inserted += 1

    db.execute("COMMIT")
    print(f"plants:                    {inserted} inserted "
          f"(skipped rank={skipped_rank}, no_symbol={skipped_no_symbol})")
    print(f"  photos: {photos_direct + photos_via_parent}/{inserted} "
          f"({photos_direct} direct + {photos_via_parent} via parent species)")
    return symbol_to_id


# ---- Multi-valued attributes --------------------------------------------

def insert_habits_durations_names(
    db: sqlite3.Connection, symbol_to_id: dict[str, int]
) -> None:
    profile_dir = RAW / "profiles"
    n_habits = n_durations = n_names = n_native = 0
    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        # Find the file by USDA plant id (== filename stem).
        # Use the profile already used in insert_plants? Re-read is cheap given <5k plants.
        # Map sym → usda_plant_id via direct lookup:
        row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = row[0] if row else None
        if not upid:
            continue
        path = profile_dir / f"{upid}.json"
        if not path.exists():
            continue
        p = json.loads(path.read_bytes())

        for h in p.get("GrowthHabits") or []:
            if h:
                db.execute(
                    "INSERT OR IGNORE INTO plant_growth_habits (plant_id, growth_habit) VALUES (?, ?)",
                    (pid, h),
                )
                n_habits += 1
        for d in p.get("Durations") or []:
            if d in ("Perennial", "Annual", "Biennial"):
                db.execute(
                    "INSERT OR IGNORE INTO plant_durations (plant_id, duration) VALUES (?, ?)",
                    (pid, d),
                )
                n_durations += 1
        if p.get("CommonName"):
            db.execute(
                "INSERT OR IGNORE INTO plant_common_names (plant_id, common_name, is_primary) VALUES (?, ?, 1)",
                (pid, p["CommonName"]),
            )
            n_names += 1
        for oc in p.get("OtherCommonNames") or []:
            if oc:
                db.execute(
                    "INSERT OR IGNORE INTO plant_common_names (plant_id, common_name, is_primary) VALUES (?, ?, 0)",
                    (pid, oc),
                )
                n_names += 1
        for ns in p.get("NativeStatuses") or []:
            region = ns.get("Region")
            status = (ns.get("Type") or "Unknown")
            if status not in ("Native", "Introduced", "Both", "Waif", "Unknown"):
                status = "Unknown"
            if region:
                db.execute(
                    "INSERT OR IGNORE INTO plant_native_status (plant_id, region_code, status) VALUES (?, ?, ?)",
                    (pid, region, status),
                )
                n_native += 1
    db.execute("COMMIT")
    print(f"plant_growth_habits:       {n_habits}")
    print(f"plant_durations:           {n_durations}")
    print(f"plant_common_names:        {n_names}")
    print(f"plant_native_status:       {n_native}")


# ---- County distribution -------------------------------------------------

def insert_distribution(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    """Read every per-state distribution chunk and insert into plant_county_distribution.

    Maps county_name → usda_plant_location_id via counties.json scoped by the
    chunk's state, then loc_id → county_fips via the counties table.
    """
    state_dir = RAW / "distribution_per_state"
    counties_path = RAW / "counties.json"

    if not state_dir.exists() or not counties_path.exists():
        # Backwards-compat: fall back to MT-only files if the multi-state
        # layout isn't present.
        dist_path = RAW / "mt_distribution.json"
        mt_counties_path = RAW / "mt_counties.json"
        if not dist_path.exists() or not mt_counties_path.exists():
            print("Distribution data missing — plant_county_distribution will be empty.")
            return
        print("Using MT-only legacy paths")
        chunks = [("MT", json.loads(dist_path.read_bytes()))]
        mt_counties = json.loads(mt_counties_path.read_bytes())
        name_by_state = {"MT": {c["PlantLocationName"]: c["PlantLocationId"] for c in mt_counties}}
    else:
        # Build state_code → (county_name → usda_plant_location_id)
        name_by_state: dict[str, dict[str, int]] = defaultdict(dict)
        for c in json.loads(counties_path.read_bytes()):
            name_by_state[c["state_code"]][c["county_name"]] = c["usda_plant_location_id"]
        chunks = []
        for chunk_path in sorted(state_dir.glob("*.json")):
            if chunk_path.name.endswith(".partial.json"):
                continue
            sc = chunk_path.stem
            chunks.append((sc, json.loads(chunk_path.read_bytes())))

    # plant_location_id (USDA) → county_fips (nationwide; counties table is now full)
    fips_by_loc_id = dict(
        db.execute(
            "SELECT usda_plant_location_id, county_fips FROM counties"
        ).fetchall()
    )

    # plant_master_id → row_id via usda_plant_id lookup
    pid_by_master = dict(
        db.execute("SELECT usda_plant_id, id FROM plants WHERE usda_plant_id IS NOT NULL").fetchall()
    )

    seen: set[tuple[int, str]] = set()
    inserted = 0
    skipped_no_county = skipped_no_plant = 0

    db.execute("BEGIN")
    for state_code, distribution in chunks:
        name_to_loc_id = name_by_state.get(state_code, {})
        state_inserted = 0
        state_skip_county = state_skip_plant = 0
        for row in distribution:
            county_name = row.get("country_subdivision_name")
            if county_name not in name_to_loc_id:
                continue
            loc_id = name_to_loc_id[county_name]
            fips = fips_by_loc_id.get(loc_id)
            if not fips:
                state_skip_county += 1
                continue
            upid = row.get("plant_master_id")
            plant_id = pid_by_master.get(upid)
            if not plant_id:
                state_skip_plant += 1
                continue
            nativity = row.get("Symbol")
            if nativity not in ("Native", "Introduced", "Both"):
                continue
            key = (plant_id, fips)
            if key in seen:
                continue
            seen.add(key)
            db.execute(
                "INSERT INTO plant_county_distribution (plant_id, county_fips, nativity) VALUES (?, ?, ?)",
                (plant_id, fips, nativity),
            )
            inserted += 1
            state_inserted += 1
        skipped_no_county += state_skip_county
        skipped_no_plant += state_skip_plant
        print(f"  {state_code}: {state_inserted:,} rows "
              f"(no_county={state_skip_county}, no_plant={state_skip_plant})")
    db.execute("COMMIT")
    print(f"plant_county_distribution: {inserted:,} total "
          f"(skipped no_county={skipped_no_county}, no_plant={skipped_no_plant})")


# ---- Tabs: characteristics, wildlife, wetland, synonyms, status, refs ----

def _tab_path(tab: str, upid: int) -> Path:
    return RAW / "tabs" / tab / f"{upid}.json"


def insert_characteristics(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    cols_seen: set[str] = set()
    inserted = 0
    unknown_names: set[str] = set()

    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        upid_row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = upid_row[0] if upid_row else None
        if not upid:
            continue
        path = _tab_path("characteristics", upid)
        if not path.exists():
            continue
        try:
            entries = json.loads(path.read_bytes())
        except Exception:
            continue
        if not entries:
            continue

        # Collapse entries to {column: value}, wild-type only (CultivarName is null).
        values: dict[str, object | None] = {}
        for e in entries:
            if e.get("CultivarName"):
                continue
            name = e.get("PlantCharacteristicName")
            raw = e.get("PlantCharacteristicValue")
            mapping = _CHAR_MAP.get(name)
            if mapping is None:
                if name:
                    unknown_names.add(name)
                continue
            col, conv = mapping
            v = conv(raw)
            if v is not None and col not in values:
                values[col] = v

        if not values:
            continue
        cols = ["plant_id"] + list(values.keys())
        cols_seen.update(values.keys())
        placeholders = ",".join("?" for _ in cols)
        col_list = ",".join(cols)
        db.execute(
            f"INSERT INTO plant_characteristics ({col_list}) VALUES ({placeholders})",
            [pid] + list(values.values()),
        )
        inserted += 1
    db.execute("COMMIT")
    print(f"plant_characteristics:     {inserted}  ({len(cols_seen)} distinct columns populated)")
    if unknown_names:
        print(f"  unknown characteristic names (not yet mapped to columns): {sorted(unknown_names)[:5]}{' …' if len(unknown_names)>5 else ''}")


def insert_wildlife(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    inserted = 0
    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        upid_row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = upid_row[0] if upid_row else None
        if not upid:
            continue
        path = _tab_path("wildlife", upid)
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_bytes())
        except Exception:
            continue
        for use_type, key in (("Food", "Food"), ("Cover", "Cover")):
            for entry in payload.get(key) or []:
                src = entry.get("Source")
                if not src:
                    continue
                try:
                    db.execute(
                        """INSERT OR IGNORE INTO plant_wildlife_value
                           (plant_id, use_type, source_reference,
                            large_mammals, small_mammals, water_birds, terrestrial_birds)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (pid, use_type, src,
                         entry.get("LargeMammals") or "",
                         entry.get("SmallMammals") or "",
                         entry.get("WaterBirds") or "",
                         entry.get("TerrestrialBirds") or ""),
                    )
                    inserted += 1
                except sqlite3.IntegrityError:
                    pass
    db.execute("COMMIT")
    print(f"plant_wildlife_value:      {inserted}")


def insert_wetland(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    inserted = 0
    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        upid_row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = upid_row[0] if upid_row else None
        if not upid:
            continue
        path = _tab_path("wetland", upid)
        if not path.exists():
            continue
        try:
            entries = json.loads(path.read_bytes())
        except Exception:
            continue
        for entry in entries or []:
            for d in entry.get("WetlandDesignations") or []:
                region = d.get("Region")
                code = d.get("WetlandCode")
                if not region or code not in ("OBL", "FACW", "FAC", "FACU", "UPL", "NL"):
                    continue
                sub = d.get("SubRegion")
                try:
                    db.execute(
                        "INSERT OR IGNORE INTO plant_wetland_indicators (plant_id, region, sub_region, wetland_code) "
                        "VALUES (?, ?, ?, ?)",
                        (pid, region, sub, code),
                    )
                    inserted += 1
                except sqlite3.IntegrityError:
                    pass
    db.execute("COMMIT")
    print(f"plant_wetland_indicators:  {inserted}")


def insert_synonyms(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    inserted = 0
    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        upid_row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = upid_row[0] if upid_row else None
        if not upid:
            continue
        path = _tab_path("synonyms", upid)
        if not path.exists():
            continue
        try:
            entries = json.loads(path.read_bytes())
        except Exception:
            continue
        for s in entries or []:
            syn_sym = s.get("Symbol")
            syn_name = _clean(s.get("ScientificName"))
            if not syn_sym or not syn_name:
                continue
            db.execute(
                "INSERT OR IGNORE INTO plant_synonyms (accepted_plant_id, synonym_usda_symbol, synonym_scientific_name) "
                "VALUES (?, ?, ?)",
                (pid, syn_sym, syn_name),
            )
            inserted += 1
    db.execute("COMMIT")
    print(f"plant_synonyms:            {inserted}")


def insert_status(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    inserted = 0
    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        upid_row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = upid_row[0] if upid_row else None
        if not upid:
            continue
        for tab, status_type, field in (
            ("legal_status",    "Legal",    "ConservationStatuses"),
            ("invasive_status", "Invasive", "InvasiveStatuses"),
            ("noxious_status",  "Noxious",  "NoxiousStatuses"),
        ):
            path = _tab_path(tab, upid)
            if not path.exists():
                continue
            try:
                entries = json.loads(path.read_bytes())
            except Exception:
                continue
            for e in entries or []:
                locality = e.get("LocalityName")
                if not locality:
                    continue
                locality_type = "State" if e.get("IsStateStatus") else "Federal"
                for s in e.get(field) or []:
                    if isinstance(s, str):
                        value = s
                    elif isinstance(s, dict):
                        value = "; ".join(f"{k}={v}" for k, v in s.items() if v not in (None, "", []))
                    else:
                        continue
                    if not value:
                        continue
                    db.execute(
                        "INSERT OR IGNORE INTO plant_status (plant_id, status_type, locality_type, locality_name, status_value) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (pid, status_type, locality_type, locality, value),
                    )
                    inserted += 1
    db.execute("COMMIT")
    print(f"plant_status:              {inserted}")


def insert_external_refs(db: sqlite3.Connection, symbol_to_id: dict[str, int]) -> None:
    inserted_links = inserted_docs = 0
    db.execute("BEGIN")
    for sym, pid in symbol_to_id.items():
        upid_row = db.execute("SELECT usda_plant_id FROM plants WHERE id = ?", (pid,)).fetchone()
        upid = upid_row[0] if upid_row else None
        if not upid:
            continue

        path = _tab_path("related_links", upid)
        if path.exists():
            try:
                entries = json.loads(path.read_bytes())
            except Exception:
                entries = []
            for r in entries or []:
                db.execute(
                    "INSERT INTO plant_external_references (plant_id, reference_type, ref_label, ref_url) "
                    "VALUES (?, ?, ?, ?)",
                    (pid, "related_link", r.get("LinkText"), r.get("Url")),
                )
                inserted_links += 1

        path = _tab_path("documentation", upid)
        if path.exists():
            try:
                payload = json.loads(path.read_bytes())
            except Exception:
                payload = {}
            for d in payload.get("DataSources") or []:
                db.execute(
                    "INSERT INTO plant_external_references "
                    "(plant_id, reference_type, ref_citation, ref_data_source_type, ref_locality) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (pid, "documentation",
                     d.get("DataSourceString"),
                     d.get("DataSourceType"),
                     d.get("DataSourceLocalityString")),
                )
                inserted_docs += 1
    db.execute("COMMIT")
    print(f"plant_external_references: {inserted_links + inserted_docs} "
          f"(links={inserted_links}, docs={inserted_docs})")


# ---- Validation ----------------------------------------------------------

def validate(db: sqlite3.Connection) -> None:
    print("\n=== Validation queries ===")

    rows = db.execute("SELECT COUNT(*) FROM plants").fetchone()
    print(f"plants total:                  {rows[0]}")

    rows = db.execute(
        "SELECT COUNT(*) FROM plants WHERE gbif_taxon_key IS NOT NULL"
    ).fetchone()
    print(f"plants with GBIF taxon key:    {rows[0]}")

    rows = db.execute(
        "SELECT COUNT(DISTINCT plant_id), COUNT(DISTINCT county_fips) FROM plant_county_distribution"
    ).fetchone()
    print(f"distinct plants in counties:   {rows[0]}, distinct counties: {rows[1]}")

    print("\n--- Drought-tolerant native trees in Gallatin County, MT ---")
    cur = db.execute(
        """SELECT p.usda_symbol, p.scientific_name, p.common_name
             FROM plants p
             JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
             JOIN plant_growth_habits        pgh ON pgh.plant_id = p.id
             JOIN plant_characteristics      pc  ON pc.plant_id = p.id
            WHERE pcd.county_fips = '30031'
              AND pcd.nativity = 'Native'
              AND pgh.growth_habit = 'Tree'
              AND pc.drought_tolerance = 'High'
            ORDER BY p.scientific_name
            LIMIT 20"""
    )
    for row in cur:
        print(f"  {row[0]:8} {row[1]:50} ({row[2]})")

    print("\n--- FTS search 'ponderosa' ---")
    cur = db.execute(
        """SELECT p.usda_symbol, p.scientific_name
             FROM plants_fts
             JOIN plants p ON p.id = plants_fts.rowid
            WHERE plants_fts MATCH 'ponderosa'
            LIMIT 5"""
    )
    for row in cur:
        print(f"  {row[0]:8} {row[1]}")

    print("\n--- LERE7 detail (bitterroot) ---")
    p = db.execute(
        "SELECT usda_symbol, scientific_name, common_name, gbif_taxon_key, gbif_canonical_name "
        "FROM plants WHERE usda_symbol='LERE7'"
    ).fetchone()
    if p:
        print(f"  {p}")
        cur = db.execute(
            "SELECT c.county_name, pcd.nativity FROM plant_county_distribution pcd "
            "JOIN plants p ON p.id = pcd.plant_id JOIN counties c ON c.county_fips = pcd.county_fips "
            "WHERE p.usda_symbol = 'LERE7' ORDER BY c.county_name"
        )
        counties = list(cur)
        print(f"  in {len(counties)} MT counties; first 5: {[c[0] for c in counties[:5]]}")


def main() -> None:
    print(f"Building {OUT}")
    db = open_db()
    seed_regions(db)
    n_states = seed_states(db)
    print(f"states:                    {n_states}")
    n_counties = seed_counties(db)
    print(f"counties:                  {n_counties}")

    gbif = load_gbif_matches()
    print(f"GBIF matches available:    {len(gbif)}")

    photos = load_inat_photos()
    photos_ok = sum(1 for v in photos.values() if v.get("match_status") == "OK")
    print(f"iNat photos available:     {photos_ok}/{len(photos)}")

    symbol_to_id = insert_plants(db, gbif, photos)
    insert_habits_durations_names(db, symbol_to_id)
    insert_distribution(db, symbol_to_id)
    insert_characteristics(db, symbol_to_id)
    insert_wildlife(db, symbol_to_id)
    insert_wetland(db, symbol_to_id)
    insert_synonyms(db, symbol_to_id)
    insert_status(db, symbol_to_id)
    insert_external_refs(db, symbol_to_id)

    validate(db)
    db.close()

    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"\nFinal DB: {OUT} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
