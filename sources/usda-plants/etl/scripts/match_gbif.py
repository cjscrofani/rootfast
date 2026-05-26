"""Match every cached USDA plant against GBIF Backbone Taxonomy.

For each plant in the USDA profile cache, call GBIF's /species/match
endpoint to find the canonical taxonomic backbone entry. The resulting
`gbif_taxon_key` is the join key across every current and future Rootfast
data source (USDA Plants, USDA Hardiness, iNaturalist, Wikidata, ...).

Process:
1. Walk profile files at raw/profiles/{id}.json.
2. For each plant, call
      https://api.gbif.org/v1/species/match?name=...&family=...&verbose=true
   with the family/genus context USDA gives us (cuts false fuzzy matches).
3. Pick the best result from primary + alternatives:
      - prefer EXACT match at requested rank
      - if the matched record is a SYNONYM, follow acceptedUsageKey to the
        canonical species (we store the accepted key as gbif_taxon_key so
        all sources join on the same canonical identity)
4. Cache results to raw/gbif_matches.json keyed by USDA symbol.
   Idempotent: skips symbols already in the cache.

Outputs the full GBIF response (small, ~1KB each) so future schema
backfills (adding new GBIF fields) don't require re-querying.

Stdlib + ThreadPoolExecutor. GBIF tolerates ~16 concurrent unauth requests.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

GBIF = "https://api.gbif.org/v1/species/match"
UA = "rootfast/0.0.1 (https://github.com/...; gbif backbone match)"
WORKERS = 16

# USDA Rank → GBIF rank vocabulary.
_RANK_MAP = {
    "Species":    "SPECIES",
    "Subspecies": "SUBSPECIES",
    "Variety":    "VARIETY",
    "Form":       "FORM",
}

# Strip <i>...</i> wrapping USDA puts around scientific names.
_TAG = re.compile(r"<[^>]+>")


# scripts/X.py → etl/scripts → etl/
ETL_ROOT = Path(__file__).resolve().parent.parent
PROFILE_DIR = ETL_ROOT / "raw" / "profiles"
OUT = ETL_ROOT / "raw" / "gbif_matches.json"


def _clean(s: str | None) -> str | None:
    if not s:
        return None
    return _TAG.sub("", s).strip() or None


def _binomial(sci: str | None) -> str | None:
    """Strip authority — GBIF accepts both forms but binomial is more reliable."""
    clean = _clean(sci)
    if not clean:
        return None
    parts = clean.split()
    if len(parts) < 2:
        return None
    # Preserve subspecies/variety markers if present.
    rebuilt = parts[0] + " " + parts[1]
    for i, p in enumerate(parts[2:], start=2):
        if p in ("subsp.", "ssp.", "var.", "f.") and i + 1 < len(parts):
            rebuilt += " " + p + " " + parts[i + 1]
            break
    return rebuilt


def _http_get_json(url: str, retries: int = 5) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(2 ** attempt)
    assert last is not None
    raise last


def _family_from_profile(profile: dict) -> str | None:
    for anc in profile.get("Ancestors") or []:
        if anc.get("Rank") == "Family":
            return _clean(anc.get("ScientificName"))
    return None


def _genus_from_profile(profile: dict) -> str | None:
    for anc in profile.get("Ancestors") or []:
        if anc.get("Rank") == "Genus":
            return _clean(anc.get("ScientificName"))
    return None


def _pick_best(primary: dict, alternatives: list[dict], wanted_rank: str | None) -> dict:
    """Pick the most useful match from primary + alternatives.

    Strategy:
      1. If primary matchType is EXACT or FUZZY at the wanted rank → use it.
      2. Otherwise scan alternatives for one that's EXACT at the wanted rank
         (synonyms are OK — they point at the accepted via acceptedUsageKey).
      3. Fall back to primary unchanged.
    """
    if not wanted_rank:
        return primary

    def good(m: dict) -> bool:
        return (
            m.get("matchType") in ("EXACT", "FUZZY")
            and (m.get("rank") or "").upper() == wanted_rank
            and m.get("usageKey")
        )

    if good(primary):
        return primary
    for alt in alternatives or []:
        if good(alt):
            return alt
    return primary


def _normalize_match(match: dict) -> dict:
    """Distill the GBIF response into the columns the schema cares about.

    Always returns the *accepted* taxon key as gbif_taxon_key — so every
    source that ingests via this script joins on canonical identity, even
    when the USDA name is a synonym."""
    accepted_key = match.get("acceptedUsageKey") or match.get("usageKey")
    return {
        "gbif_taxon_key":         accepted_key,
        "gbif_usage_key":         match.get("usageKey"),
        "gbif_accepted_usage_key": match.get("acceptedUsageKey"),
        "gbif_canonical_name":    match.get("canonicalName"),
        "gbif_scientific_name":   match.get("scientificName"),
        "gbif_rank":              match.get("rank"),
        "gbif_match_type":        match.get("matchType"),
        "gbif_match_status":      match.get("status"),
        "gbif_match_confidence":  match.get("confidence"),
        "gbif_kingdom":           match.get("kingdom"),
        "gbif_family":            match.get("family"),
        "gbif_genus":             match.get("genus"),
        "gbif_species":           match.get("species"),
        "gbif_kingdom_key":       match.get("kingdomKey"),
        "gbif_family_key":        match.get("familyKey"),
        "gbif_genus_key":         match.get("genusKey"),
        "gbif_species_key":       match.get("speciesKey"),
        "gbif_note":              match.get("note"),
    }


def match_one(profile_path: Path) -> tuple[str, dict] | None:
    try:
        profile = json.loads(profile_path.read_bytes())
    except Exception:
        return None

    symbol = profile.get("Symbol")
    if not symbol:
        return None

    binomial = _binomial(profile.get("ScientificName"))
    if not binomial:
        return None

    usda_rank = profile.get("Rank")
    gbif_rank = _RANK_MAP.get(usda_rank or "")

    params = {"name": binomial, "verbose": "true"}
    if gbif_rank:
        params["rank"] = gbif_rank
    family = _family_from_profile(profile)
    if family:
        params["family"] = family
    genus = _genus_from_profile(profile)
    if genus:
        params["genus"] = genus

    url = f"{GBIF}?{urllib.parse.urlencode(params)}"
    try:
        resp = _http_get_json(url)
    except Exception as e:
        return symbol, {
            "error": str(e),
            "gbif_match_type": "NONE",
            "usda_symbol": symbol,
        }

    alternatives = resp.pop("alternatives", None)
    best = _pick_best(resp, alternatives or [], gbif_rank)

    record = _normalize_match(best)
    record["usda_symbol"] = symbol
    record["usda_scientific_name"] = _clean(profile.get("ScientificName"))
    record["usda_rank"] = usda_rank
    record["gbif_query_name"] = binomial
    # Keep the raw response too, for backfills.
    record["_gbif_raw_primary"] = resp
    if alternatives:
        # Trim alternatives to first 5 to keep cache size manageable.
        record["_gbif_raw_alternatives"] = alternatives[:5]
    return symbol, record


def main() -> None:
    if not PROFILE_DIR.exists():
        sys.exit(f"Missing {PROFILE_DIR}. Run fetch_usda_plants_mt.py first.")

    existing: dict[str, dict] = {}
    if OUT.exists():
        existing = json.loads(OUT.read_bytes())
        print(f"Reusing {len(existing)} cached matches from {OUT.name}")

    profile_files = sorted(PROFILE_DIR.glob("*.json"))
    print(f"Profile cache: {len(profile_files)} plants")

    # Skip ones already done. Match by SYMBOL, not file id — file id is the
    # plant_master_id which doesn't match what we key by.
    todo: list[Path] = []
    for path in profile_files:
        try:
            sym = json.loads(path.read_bytes()).get("Symbol")
        except Exception:
            continue
        if sym and sym not in existing:
            todo.append(path)
    print(f"Need to match: {len(todo)}")

    new: dict[str, dict] = {}
    completed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for fut in as_completed([ex.submit(match_one, p) for p in todo]):
            result = fut.result()
            completed += 1
            if result is None:
                continue
            sym, rec = result
            new[sym] = rec
            if completed % 200 == 0:
                print(f"  {completed}/{len(todo)} matched")

    merged = {**existing, **new}
    OUT.write_text(json.dumps(merged, indent=2, sort_keys=True))
    print(f"\nWrote {len(merged)} matches to {OUT}")

    # Summary
    from collections import Counter
    by_type = Counter(r.get("gbif_match_type") for r in merged.values())
    by_status = Counter(r.get("gbif_match_status") for r in merged.values())
    with_key = sum(1 for r in merged.values() if r.get("gbif_taxon_key"))
    print(f"\nGBIF taxon key assigned: {with_key}/{len(merged)} ({100*with_key/max(len(merged),1):.1f}%)")
    print("Match type breakdown:")
    for t, n in by_type.most_common():
        print(f"  {t or '(none)':12}  {n}")
    print("Match status breakdown:")
    for s, n in by_status.most_common():
        print(f"  {s or '(none)':12}  {n}")


if __name__ == "__main__":
    main()
