"""Parse cached Field Guide HTML into one explorable JSON.

Reads:
    data/raw/field_guide/species/{ELCODE}.html
    data/raw/field_guide/obs_chart/{ELCODE}.html

Writes:
    data/raw/field_guide/mt_field_guide_full.json
        One record per ELCODE with scientific name, narrative sections,
        statewide range stats, and monthly observation phenology.

Also computes a `usda_symbol` crosswalk by matching the binomial against
the USDA PLANTS scientific names we already have in mt_plants_full.json,
so the merge step has a clean join key.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

# scripts/X.py → data/scripts → data/
DATA_ROOT = Path(__file__).resolve().parent.parent
ROOT = DATA_ROOT / "raw" / "field_guide"
SPECIES_DIR = ROOT / "species"
OBS_DIR = ROOT / "obs_chart"
OUT = ROOT / "mt_field_guide_full.json"
OUT_SUMMARY = ROOT / "mt_field_guide_full.summary.json"

USDA_FULL = DATA_ROOT / "raw" / "usda_plants" / "mt_plants_full.json"
USDA_PROFILES = DATA_ROOT / "raw" / "usda_plants" / "profiles"
USDA_SYNONYMS = DATA_ROOT / "raw" / "usda_plants" / "tabs" / "synonyms"
USDA_SUBORDINATE = DATA_ROOT / "raw" / "usda_plants" / "tabs" / "subordinate_taxa"

# Strip the author authority and HTML tags from a scientific name.
# USDA returns "<i>Acer glabrum</i> Torr." — Field Guide uses "Acer glabrum".
# Match on the first two whitespace-delimited tokens (the binomial).
_RE_HTML = re.compile(r"<[^>]+>")


def _binomial(sci: str | None) -> str | None:
    if not sci:
        return None
    clean = _RE_HTML.sub("", sci).strip()
    parts = clean.split()
    if len(parts) < 2:
        return None
    return f"{parts[0]} {parts[1]}".lower()


def _build_crosswalk() -> tuple[dict[str, str], dict[str, str]]:
    """Return (direct_binomial_to_symbol, synonym_binomial_to_accepted_symbol).

    direct: binomial → accepted USDA symbol (from MT consolidated file)
    synonyms: synonym binomial → accepted USDA symbol, derived from:
        1. USDA's PlantSynonyms tab (file_id is the accepted plant's id)
        2. USDA's PlantSubordinateTaxa tab (each subordinate may have an
           alternate parent binomial via its own ScientificName)
    """
    direct: dict[str, str] = {}
    if USDA_FULL.exists():
        usda = json.loads(USDA_FULL.read_bytes())
        for sym, rec in usda.items():
            b = _binomial(rec.get("scientific_name"))
            if b and b not in direct:
                direct[b] = sym

    # Build id → accepted symbol map (from PlantProfile cache).
    id_to_symbol: dict[int, str] = {}
    for p in USDA_PROFILES.glob("*.json"):
        try:
            d = json.loads(p.read_bytes())
        except Exception:
            continue
        sym = d.get("Symbol")
        pid = d.get("Id")
        if sym and pid:
            id_to_symbol[pid] = sym

    synonyms: dict[str, str] = {}

    if USDA_SYNONYMS.exists():
        for path in USDA_SYNONYMS.glob("*.json"):
            try:
                pid = int(path.stem)
            except ValueError:
                continue
            accepted_symbol = id_to_symbol.get(pid)
            if not accepted_symbol:
                continue
            try:
                syns = json.loads(path.read_bytes())
            except Exception:
                continue
            for s in syns or []:
                b = _binomial(s.get("ScientificName"))
                if not b:
                    continue
                # Don't overwrite a direct match — direct is always preferred.
                if b in direct:
                    continue
                # First synonym wins; later collisions ignored to avoid flip-flop.
                synonyms.setdefault(b, accepted_symbol)

    # PlantSubordinateTaxa also exposes alt binomials for subspecies/varieties
    # under a parent species. Useful for cases where Field Guide treats a
    # variety at species rank.
    if USDA_SUBORDINATE.exists():
        for path in USDA_SUBORDINATE.glob("*.json"):
            try:
                pid = int(path.stem)
            except ValueError:
                continue
            accepted_symbol = id_to_symbol.get(pid)
            if not accepted_symbol:
                continue
            try:
                payload = json.loads(path.read_bytes())
            except Exception:
                continue
            for s in (payload or {}).get("SubordinateTaxa", []) or []:
                b = _binomial(s.get("ScientificName"))
                if not b or b in direct or b in synonyms:
                    continue
                # Subordinate taxa may have their own USDA symbol; prefer that
                # if we know it, otherwise point at the parent.
                child_symbol = s.get("Symbol") or accepted_symbol
                synonyms.setdefault(b, child_symbol)

    return direct, synonyms


def _normspace(s: str | None) -> str | None:
    if not s:
        return None
    return re.sub(r"\s+", " ", s).strip() or None


def _section_text(soup: BeautifulSoup, sid: str) -> str | None:
    el = soup.find(id=sid)
    if not el:
        return None
    return _normspace(el.get_text(" ", strip=True))


def _citations(soup: BeautifulSoup) -> list[str]:
    cit = soup.find(id="cit")
    if not cit:
        return []
    out: list[str] = []
    for li in cit.find_all("li"):
        t = _normspace(li.get_text(" ", strip=True))
        if t:
            out.append(t[:400])
    return out


_RE_SCI    = re.compile(r'var SciName\s*=\s*"([^"]+)"')
_RE_ELCODE = re.compile(r'var ELCODE\s*=\s*"([^"]+)"')
_RE_RANGE  = re.compile(r"var dataStatewideModelOwners\s*=\s*`([^`]+)`", re.DOTALL)
_RE_MONTH  = re.compile(r"<tr><th>(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Total)</th><(?:td|th)>(\d+)</(?:td|th)></tr>")
_RE_COMMON_TITLE = re.compile(r"<title>([^-]+) - Montana Field Guide</title>")


def parse_species(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")

    sci_m = _RE_SCI.search(html)
    el_m  = _RE_ELCODE.search(html)
    com_m = _RE_COMMON_TITLE.search(html)

    rec: dict[str, Any] = {
        "elcode":           el_m.group(1) if el_m else None,
        "scientific_name":  sci_m.group(1) if sci_m else None,
        "common_name":      _normspace(com_m.group(1)) if com_m else None,
        "general":          _section_text(soup, "gen"),
        "habitat":          _section_text(soup, "habt"),
        "distribution":     _section_text(soup, "dist"),
        "citations":        _citations(soup),
    }

    range_m = _RE_RANGE.search(html)
    if range_m:
        try:
            data = json.loads(range_m.group(1))
            rec["range_stats"] = data.get("AreaInfo")
            rec["owners"]      = data.get("Owners")
        except json.JSONDecodeError:
            rec["range_stats"] = None
            rec["owners"]      = None

    return rec


def parse_obs(html: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for m in _RE_MONTH.finditer(html):
        key, val = m.group(1), int(m.group(2))
        out[key] = val
    return out


def main() -> None:
    if not SPECIES_DIR.exists():
        sys.exit("Run scripts/fetch_field_guide_mt.py first.")

    # USDA crosswalk: direct binomial + synonym + subordinate-taxa lookups.
    print("Building USDA crosswalk...")
    direct_map, synonym_map = _build_crosswalk()
    print(f"  {len(direct_map)} direct binomials  +  {len(synonym_map)} synonym/subordinate binomials")

    species_files = sorted(SPECIES_DIR.glob("*.html"))
    print(f"Parsing {len(species_files)} species pages...")

    records: dict[str, dict] = {}
    rank_skips = 0
    parse_errors = 0
    for path in species_files:
        try:
            html = path.read_text(errors="replace")
            rec = parse_species(html)
        except Exception as e:
            parse_errors += 1
            print(f"  parse error {path.name}: {e}")
            continue

        elc = rec.get("elcode") or path.stem
        if not elc:
            continue

        # Phenology from ObsChart.
        obs_path = OBS_DIR / f"{elc}.html"
        if obs_path.exists():
            rec["monthly_obs"] = parse_obs(obs_path.read_text(errors="replace"))
        else:
            rec["monthly_obs"] = {}

        # USDA crosswalk: direct first, then synonym fallback.
        b = _binomial(rec.get("scientific_name"))
        sym = direct_map.get(b) if b else None
        match_via = "direct" if sym else None
        if not sym and b:
            sym = synonym_map.get(b)
            if sym:
                match_via = "synonym"
        rec["usda_symbol"] = sym
        rec["usda_match_via"] = match_via

        records[elc] = rec

    OUT.write_text(json.dumps(records, indent=2, sort_keys=True))
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"\nWrote {len(records)} records → {OUT} ({size_mb:.1f} MB)")
    if parse_errors:
        print(f"Parse errors: {parse_errors}")

    # Coverage stats.
    matched = sum(1 for r in records.values() if r.get("usda_symbol"))
    matched_via = Counter(r.get("usda_match_via") for r in records.values() if r.get("usda_match_via"))
    has_general = sum(1 for r in records.values() if r.get("general"))
    has_habt    = sum(1 for r in records.values() if r.get("habitat"))
    has_obs     = sum(1 for r in records.values() if r.get("monthly_obs", {}).get("Total"))
    has_owners  = sum(1 for r in records.values() if r.get("owners"))

    elcode_prefixes = Counter(elc[:2] for elc in records)

    summary = {
        "record_count": len(records),
        "usda_crosswalk_matched": matched,
        "usda_crosswalk_pct": round(100.0 * matched / max(len(records), 1), 1),
        "usda_crosswalk_via": dict(matched_via),
        "has_general_desc": has_general,
        "has_habitat":      has_habt,
        "has_monthly_obs":  has_obs,
        "has_range_stats":  has_owners,
        "elcode_prefix_counts": dict(elcode_prefixes),
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2, sort_keys=True))

    print("\n=== Coverage ===")
    print(f"  records:               {len(records)}")
    print(f"  USDA crosswalk match:  {matched} ({summary['usda_crosswalk_pct']}%)")
    for via, n in matched_via.most_common():
        print(f"    via {via}: {n}")
    print(f"  has_general_desc:      {has_general}")
    print(f"  has_habitat:           {has_habt}")
    print(f"  has_monthly_obs:       {has_obs}")
    print(f"  has_range_stats:       {has_owners}")
    print(f"\n  ELCODE prefixes (kingdom/phylum codes):")
    for p, n in elcode_prefixes.most_common():
        print(f"    {p}: {n}")


if __name__ == "__main__":
    main()
